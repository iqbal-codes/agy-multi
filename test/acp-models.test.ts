import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
// These tests drive real child processes; the 5 s default flakes on loaded CI runners.
setDefaultTimeout(20_000);

import { isRecord } from "../src/fs-utils";
import { LineReader } from "../src/acp/rpc";

/**
 * Fake agy binary with two tiers:
 * - `acct-basic`: only supports `gemini-3.8-flash-high` (and `gemini-3.8-flash`)
 * - `acct-pro`: supports `gemini-3.8-flash-high`, `gemini-4-hydrogen-high`, `gemini-4-argon-high`
 *
 * `acct-basic` reports higher quota (95%) than `acct-pro` (70%), so without
 * model capability awareness `acct-basic` would always be picked first.
 */
const FAKE_TIERED_AGY = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = Bun.argv.slice(2);
const home = process.env.HOME ?? "";
const isPro = home.includes("acct-pro");
const promptLog = process.env.FAKE_AGY_LOG;
const probeLog = process.env.FAKE_AGY_PROBE_LOG;
const extendedCatalog = process.env.FAKE_AGY_EXTENDED_CATALOG === "1";

const BASIC_MODELS = [
  { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
];
const PRO_MODELS = [
  { modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
  { modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
  { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
];

const BASIC_CONFIG = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gemini-3.8-flash",
    options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }],
  },
];
const PRO_CONFIG = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gemini-4-argon",
    options: [
      { value: "gemini-4-argon", name: "Gemini 4 Argon" },
      { value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
      { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    ],
  },
];

if (extendedCatalog) {
  for (const [id, name] of [
    ["gemini-4-carbon", "Gemini 4 Carbon"],
    ["gemini-5-flash", "Gemini 5 Flash"],
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["gpt-oss-120b", "GPT-OSS"],
    ["gemini-pro-orchestrator", "Orchestrator"],
  ]) {
    PRO_MODELS.push({ modelId: id, name });
    PRO_CONFIG[0].options.push({ value: id, name });
  }
}

function modelConfig(modelId) {
  const selector = { ...(isPro ? PRO_CONFIG[0] : BASIC_CONFIG[0]), currentValue: modelId };
  if (extendedCatalog) {
    selector.options = [{ group: "models", name: "Models", options: selector.options }];
    return [selector];
  }
  if (!probeLog) return isPro ? PRO_CONFIG : BASIC_CONFIG;
  const levels = modelId === "gemini-4-hydrogen" ? ["medium", "high"] : ["low", "high"];
  return [selector, {
    id: "thinking", name: "Thinking", category: "thought_level", type: "select",
    currentValue: levels[0], options: levels.map(value => ({ value, name: value.toUpperCase() })),
  }];
}

if (argv.includes("/usage")) {
  const pct = isPro ? "70%" : "95%";
  process.stdout.write(JSON.stringify({
    status: "SUCCESS",
    response: [
      "Gemini Models\\tWeekly Limit Remaining\\t" + pct + "\\t2099-01-01T00:00:00Z",
      "Gemini Models\\tFive Hour Limit Remaining\\t" + pct + "\\t2099-01-01T00:00:00Z",
    ].join("\\n"),
  }) + "\\n");
  process.exit(0);
}

if (argv[0] === "models") {
  const list = isPro ? PRO_MODELS : BASIC_MODELS;
  for (const m of list) {
    process.stdout.write(m.modelId.padEnd(32) + m.name + "\\n");
  }
  process.exit(0);
}

if (argv[0] !== "acp") {
  process.stderr.write("unexpected args: " + argv.join(" ") + "\\n");
  process.exit(2);
}

if (argv.includes("--disable-slash-commands")) {
  process.stderr.write("unsupported ACP flag: --disable-slash-commands\\n");
  process.exit(1);
}

const sessions = new Map();
let sequence = 0;
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
const lines = createInterface({ input: process.stdin });

function supports(modelId) {
  if (!modelId) return true;
  if (isPro) {
    return ["gemini-4-hydrogen-high", "gemini-4-hydrogen", "gemini-4-argon-high", "gemini-4-argon", "gemini-3.8-flash-high", "gemini-3.8-flash"].includes(modelId);
  }
  return ["gemini-3.8-flash-high", "gemini-3.8-flash"].includes(modelId);
}

lines.on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, load: {}, resume: {}, close: {} } },
      agentInfo: { name: "fake-tiered-agy", version: "1.0.0" },
      authMethods: [],
    }});
    return;
  }
  if (message.method === "session/new") {
    const sessionId = "s-" + (++sequence);
    const defaultModel = isPro ? "gemini-4-argon-high" : "gemini-3.8-flash-high";
    sessions.set(sessionId, { modelId: defaultModel });
    send({ jsonrpc: "2.0", id: message.id, result: {
      sessionId,
      models: {
        currentModelId: defaultModel,
        availableModels: isPro ? PRO_MODELS : BASIC_MODELS,
      },
      configOptions: modelConfig((isPro ? PRO_CONFIG[0] : BASIC_CONFIG[0]).currentValue),
    }});
    return;
  }
  if (message.method === "session/set_model") {
    const modelId = message.params?.modelId;
    if (!supports(modelId)) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Unknown model ID: " + modelId } });
      return;
    }
    const s = sessions.get(message.params?.sessionId);
    if (s) s.modelId = modelId;
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/set_config_option") {
    if (message.params?.configId === "model") {
      const value = message.params?.value;
      if (!supports(value)) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Unknown model ID: " + value } });
        return;
      }
      const s = sessions.get(message.params?.sessionId);
      if (s) s.modelId = value;
      if (probeLog) appendFileSync(probeLog, value + "\\n");
      if (extendedCatalog) {
        send({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: message.params.sessionId,
          update: { sessionUpdate: "config_option_update", configOptions: modelConfig(value) },
        }});
      }
      if (probeLog && value === "gemini-4-hydrogen") {
        send({ jsonrpc: "2.0", id: message.id, result: {} });
        send({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: message.params.sessionId,
          update: { sessionUpdate: "config_option_update", configOptions: modelConfig(value) },
        }});
        return;
      }
    }
    send({ jsonrpc: "2.0", id: message.id, result: { configOptions: modelConfig(message.params?.value) } });
    return;
  }
  if (message.method === "session/prompt") {
    const s = sessions.get(message.params?.sessionId);
    const modelId = s?.modelId ?? "";
    if (promptLog) appendFileSync(promptLog, (isPro ? "acct-pro" : "acct-basic") + ":" + modelId + "\\n");
    if (!supports(modelId)) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Unknown model ID: " + modelId } });
      return;
    }
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: message.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK from " + (isPro ? "acct-pro" : "acct-basic") } },
    }});
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (message.method === "session/close") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported: " + message.method } });
});
`;

async function setupTieredEnv(adopted = false) {
	const root = await mkdtemp(join(tmpdir(), "agy-multi-models-acp-"));
	const projectRoot = join(import.meta.dir, "..");
	const fake = join(root, "fake-agy");
	const promptLog = join(root, "prompts.log");

	for (const slug of ["acct-basic", "acct-pro"]) {
		const dir = join(root, "profiles", slug);
		await mkdir(dir, { recursive: true });
		const home = adopted ? join(dir, "home") : undefined;
		await writeFile(join(dir, "profile.json"), JSON.stringify({ slug, home, createdAt: new Date().toISOString() }));
	}
	// Pre-seed usage so acct-basic (95%) ranks ahead of acct-pro (70%) when model capability is ignored
	await writeFile(
		join(root, "profiles", "acct-basic", "usage.json"),
		JSON.stringify({
			profile: "acct-basic",
			fetchedAt: Date.now(),
			windows: [
				{ family: "gemini", window: "weekly", remainingPct: 95, resetsAt: "2099-01-01T00:00:00Z" },
				{ family: "gemini", window: "fiveHour", remainingPct: 95, resetsAt: "2099-01-01T00:00:00Z" },
			],
			raw: "",
		}),
	);
	await writeFile(
		join(root, "profiles", "acct-pro", "usage.json"),
		JSON.stringify({
			profile: "acct-pro",
			fetchedAt: Date.now(),
			windows: [
				{ family: "gemini", window: "weekly", remainingPct: 70, resetsAt: "2099-01-01T00:00:00Z" },
				{ family: "gemini", window: "fiveHour", remainingPct: 70, resetsAt: "2099-01-01T00:00:00Z" },
			],
			raw: "",
		}),
	);

	await writeFile(fake, FAKE_TIERED_AGY);
	await chmod(fake, 0o755);
	return { root, projectRoot, fake, promptLog };
}

function spawnProxy(
	projectRoot: string,
	root: string,
	fake: string,
	promptLog: string,
	probeLog?: string,
	extendedCatalog = false,
	extraArgs: string[] = [],
) {
	// Cross-profile model routing is enabled in the default account pool.
	const proxy = Bun.spawn(["bun", "run", join(projectRoot, "src/index.ts"), "acp", "--switch-delay", "0", ...extraArgs], {
		cwd: projectRoot,
		env: {
			...process.env,
			AGY_MULTI_ROOT: root,
			AGY_BIN: fake,
			FAKE_AGY_LOG: promptLog,
			FAKE_AGY_PROBE_LOG: probeLog,
			FAKE_AGY_EXTENDED_CATALOG: extendedCatalog ? "1" : undefined,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdin = proxy.stdin!;
	const pending = new Map<number, (message: unknown) => void>();
	const notifications: Record<string, unknown>[] = [];
	let nextId = 1;
	const send = async <T>(method: string, params: unknown): Promise<T> => {
		const id = nextId++;
		const { promise, resolve } = Promise.withResolvers<unknown>();
		pending.set(id, resolve);
		stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		await stdin.flush();
		return (await promise) as T;
	};
	new LineReader(proxy.stdout, line => {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (isRecord(message) && typeof message.id === "number" && pending.has(message.id)) {
			const resolve = pending.get(message.id)!;
			pending.delete(message.id);
			resolve(message);
		}
		if (isRecord(message) && message.method === "session/update") notifications.push(message);
	});
	return { proxy, send, notifications };
}

describe("ACP proxy model capability routing", () => {
	test("ACP and CLI model catalogs surface public Gemini families, including future releases", async () => {
		const { root, projectRoot, fake, promptLog } = await setupTieredEnv(true);
		const basicProfile = join(root, "profiles/acct-basic/profile.json");
		await writeFile(basicProfile, JSON.stringify({ ...JSON.parse(await readFile(basicProfile, "utf8")), disabled: true }));
		// Skip background startup reasoning sync so initial session/new isn't racing against cached base-ID overlays.
		const { proxy, send, notifications } = spawnProxy(
			projectRoot,
			root,
			fake,
			promptLog,
			undefined,
			true,
			["--sequential"],
		);
		const modelIds = [
			"gemini-3.8-flash-high", "gemini-4-argon-high", "gemini-4-carbon", "gemini-4-hydrogen-high", "gemini-5-flash",
		];
		const selectorIds = [
			"gemini-3.8-flash", "gemini-4-argon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-5-flash",
		];
		try {
			await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
			const { result } = await send<{
				result: { sessionId: string; models: { availableModels: Array<{ modelId: string }> }; configOptions: unknown[] };
			}>("session/new", { cwd: root, mcpServers: [] });
			expect(result.models.availableModels.map(model => model.modelId).sort()).toEqual(modelIds);
			const choiceValues = (options: unknown[]) => {
				const model = options.find(option => isRecord(option) && option.id === "model") as { options: Array<{ value?: string; options?: Array<{ value: string }> }> };
				return model.options.flatMap(option => option.options?.map(choice => choice.value) ?? [option.value]).sort();
			};
			expect(choiceValues(result.configOptions)).toEqual(selectorIds);

			const switched = await send<{ result: { configOptions: unknown[] } }>("session/set_config_option", {
				sessionId: result.sessionId,
				configId: "model",
				value: "gemini-4-hydrogen",
			});
			expect(choiceValues(switched.result.configOptions)).toEqual(selectorIds);
			const updates = notifications.flatMap(message => {
				const params = message.params;
				if (!isRecord(params) || !isRecord(params.update) || params.update.sessionUpdate !== "config_option_update") return [];
				return [params.update.configOptions as unknown[]];
			});
			expect(updates.map(choiceValues)).toEqual([selectorIds]);

			const list = Bun.spawn([process.execPath, join(projectRoot, "src/index.ts"), "models", "--profile", "acct-pro"], {
				env: { ...process.env, AGY_MULTI_ROOT: root, AGY_BIN: fake, FAKE_AGY_EXTENDED_CATALOG: "1" },
				stdout: "pipe",
			});
			const stdout = await new Response(list.stdout).text();
			expect(await list.exited).toBe(0);
			expect(stdout.trim().split("\n").map(line => line.split("\t")[1]).sort()).toEqual(modelIds);
		} finally {
			proxy.kill();
			await proxy.exited;
			await rm(root, { recursive: true, force: true });
		}
	});

	test("session/new reads reasoning cached by another process and matches the model selector IDs", async () => {
		const { root, projectRoot, fake, promptLog } = await setupTieredEnv(true);
		const { proxy, send } = spawnProxy(projectRoot, root, fake, promptLog);
		try {
			await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
			const create = () => send<{
				result: { models: { currentModelId: string; availableModels: Array<{ modelId: string; name?: string; _meta?: unknown }> } };
			}>("session/new", { cwd: root, mcpServers: [] });
			const initial = await create();
			const high = { reasoningEfforts: [{ value: "high", label: "High" }], reasoningEffort: "high" };
			await writeFile(join(root, "profiles", "acct-pro", "models.json"), JSON.stringify({
				profile: "acct-pro",
				fetchedAt: Date.now(),
				models: [{ modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" }],
				configOptions: [{ value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" }],
			}));
			await writeFile(join(root, "profiles", "acct-pro", "model-reasoning.json"), JSON.stringify([
				{ modelId: "gemini-4-hydrogen", fetchedAt: Date.now(), meta: high },
			]));
			const next = await create();
			expect(next.result.models.currentModelId).toBe(initial.result.models.currentModelId);
			expect(next.result.models.availableModels).toContainEqual({
				modelId: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", _meta: high,
			});
			expect(await Bun.file(promptLog).exists()).toBe(false);
		} finally {
			proxy.kill();
			await proxy.exited;
			await rm(root, { recursive: true, force: true });
		}
	});

	test("profile sync refreshes all healthy accounts in parallel and caches reasoning levels", async () => {
		const { root, projectRoot, fake, promptLog } = await setupTieredEnv(true);
		const probeLog = join(root, "model-switches.log");
		const { proxy, send } = spawnProxy(projectRoot, root, fake, promptLog, probeLog);
		const sync = async (slug?: string) => {
			const proc = Bun.spawn([process.execPath, join(projectRoot, "src/index.ts"), "profile", "sync", ...(slug ? [slug] : [])], {
				cwd: projectRoot,
				env: { ...process.env, AGY_MULTI_ROOT: root, AGY_BIN: fake, FAKE_AGY_PROBE_LOG: probeLog },
				stdout: "pipe",
				stderr: "pipe",
			});
			const stderr = await new Response(proc.stderr).text();
			expect(await proc.exited, stderr).toBe(0);
		};
		try {
			await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
			// Bare `profile sync` syncs all accounts together in parallel.
			await sync();
			// Second run hits fresh caches and does not re-probe.
			await sync();
			const created = await send<{
				result: {
					models: { availableModels: Array<{ modelId: string; _meta?: unknown }> };
					configOptions: Array<{ category: string; currentValue: string }>;
				};
			}>("session/new", { cwd: root, mcpServers: [] });
			const models = created.result.models.availableModels;
			expect(created.result.configOptions.find(option => option.category === "model")?.currentValue).toBe("gemini-3.8-flash");
			expect(created.result.configOptions.find(option => option.category === "thought_level")?.currentValue).toBe("low");
			expect(models.find(model => model.modelId === "gemini-4-hydrogen")?._meta).toEqual({
				reasoningEfforts: [{ value: "medium", label: "MEDIUM" }, { value: "high", label: "HIGH" }],
				reasoningEffort: "medium",
			});
			expect(models.find(model => model.modelId === "gemini-4-argon")?._meta).toEqual({
				reasoningEfforts: [{ value: "low", label: "LOW" }, { value: "high", label: "HIGH" }],
				reasoningEffort: "low",
			});
			expect(await Bun.file(join(root, "profiles", "acct-pro", "model-reasoning.json")).exists()).toBe(true);
			expect(await Bun.file(join(root, "profiles", "acct-basic", "model-reasoning.json")).exists()).toBe(true);
			expect(await Bun.file(promptLog).exists()).toBe(false);
		} finally {
			proxy.kill();
			await proxy.exited;
			await rm(root, { recursive: true, force: true });
		}
	});

	test(
		"session/new merges cached models across profiles and session/set_model switches to a capable profile",
		async () => {
			const { root, projectRoot, fake, promptLog } = await setupTieredEnv();
			await writeFile(
				join(root, "profiles", "acct-basic", "models.json"),
				JSON.stringify({
					profile: "acct-basic",
					fetchedAt: Date.now(),
					models: [{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }],
				}),
			);
			await writeFile(
				join(root, "profiles", "acct-pro", "models.json"),
				JSON.stringify({
					profile: "acct-pro",
					fetchedAt: Date.now(),
					models: [
						{ modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
						{ modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
						{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
					],
				}),
			);

			const { proxy, send } = spawnProxy(projectRoot, root, fake, promptLog);
			try {
				await send("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "test", version: "1" } });

				const created = await send<{
					result: {
						sessionId: string;
						models?: { availableModels?: Array<{ modelId: string }> };
						configOptions?: Array<{ id: string; options?: Array<{ value: string }> }>;
					};
				}>("session/new", { cwd: root, mcpServers: [] });
				const sessionId = created.result.sessionId;
				const modelIds = created.result.models?.availableModels?.map(m => m.modelId) ?? [];
				expect(modelIds).toContain("gemini-4-hydrogen-high");
				expect(modelIds).toContain("gemini-4-argon-high");
				const modelCfg = created.result.configOptions?.find(c => c.id === "model");
				expect(modelCfg?.options?.map(o => o.value)).toContain("gemini-4-hydrogen");

				const setRes = await send<{ result?: unknown; error?: unknown }>("session/set_model", {
					sessionId,
					modelId: "gemini-4-hydrogen-high",
				});
				expect(setRes.error).toBeUndefined();

				const prompted = await send<{ result?: { stopReason: string }; error?: unknown }>("session/prompt", {
					sessionId,
					prompt: [{ type: "text", text: "Hello hydrogen" }],
				});
				expect(prompted.error).toBeUndefined();
				expect(prompted.result?.stopReason).toBe("end_turn");

				const entries = (await readFile(promptLog, "utf8")).trim().split("\n");
				expect(entries).toEqual(["acct-pro:gemini-4-hydrogen-high"]);
			} finally {
				proxy.kill();
				await proxy.exited.catch(() => {});
				await rm(root, { recursive: true, force: true });
			}
		},
		30_000,
	);

	test(
		"mid-conversation switch via session/set_config_option hands off from basic to capable profile",
		async () => {
			const { root, projectRoot, fake, promptLog } = await setupTieredEnv();
			const { proxy, send } = spawnProxy(projectRoot, root, fake, promptLog);
			try {
				await send("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "test", version: "1" } });

				const created = await send<{ result: { sessionId: string } }>("session/new", { cwd: root, mcpServers: [] });
				const sessionId = created.result.sessionId;

				// Turn 1: runs on acct-basic (95% > 70%) with gemini-3.8-flash-high
				const turn1 = await send<{ result?: { stopReason: string }; error?: unknown }>("session/prompt", {
					sessionId,
					prompt: [{ type: "text", text: "Turn 1" }],
				});
				expect(turn1.error).toBeUndefined();

				// User switches model to gemini-4-argon mid-conversation via config option
				const setCfg = await send<{ result?: unknown; error?: unknown }>("session/set_config_option", {
					sessionId,
					configId: "model",
					value: "gemini-4-argon",
				});
				expect(setCfg.error).toBeUndefined();

				// Turn 2: must automatically handoff to acct-pro without failing on acct-basic
				const turn2 = await send<{ result?: { stopReason: string }; error?: unknown }>("session/prompt", {
					sessionId,
					prompt: [{ type: "text", text: "Turn 2" }],
				});
				expect(turn2.error).toBeUndefined();
				expect(turn2.result?.stopReason).toBe("end_turn");

				const entries = (await readFile(promptLog, "utf8")).trim().split("\n");
				expect(entries).toEqual(["acct-basic:gemini-3.8-flash-high", "acct-pro:gemini-4-argon"]);
			} finally {
				proxy.kill();
				await proxy.exited.catch(() => {});
				await rm(root, { recursive: true, force: true });
			}
		},
		30_000,
	);

	test(
		"returns error when setting a model no profile supports",
		async () => {
			const { root, projectRoot, fake, promptLog } = await setupTieredEnv();
			await writeFile(
				join(root, "profiles", "acct-basic", "models.json"),
				JSON.stringify({
					profile: "acct-basic",
					fetchedAt: Date.now(),
					models: [{ modelId: "gemini-3.8-flash-high" }],
				}),
			);
			await writeFile(
				join(root, "profiles", "acct-pro", "models.json"),
				JSON.stringify({
					profile: "acct-pro",
					fetchedAt: Date.now(),
					models: [{ modelId: "gemini-4-hydrogen-high" }],
				}),
			);

			const { proxy, send } = spawnProxy(projectRoot, root, fake, promptLog);
			try {
				await send("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "test", version: "1" } });
				const created = await send<{ result: { sessionId: string } }>("session/new", { cwd: root, mcpServers: [] });
				const setRes = await send<{ error?: { message: string } }>("session/set_model", {
					sessionId: created.result.sessionId,
					modelId: "nonexistent-model-x",
				});
				expect(setRes.error).toBeDefined();
			} finally {
				proxy.kill();
				await proxy.exited.catch(() => {});
				await rm(root, { recursive: true, force: true });
			}
		},
		30_000,
	);

	test(
		"session/set_config_option and config_option_update keep all healthy profile models after routing to a smaller-catalog account",
		async () => {
			const { root, projectRoot, fake, promptLog } = await setupTieredEnv();
			// Seed acct-pro (95%) ahead of acct-basic (80%) so session/new starts on acct-pro,
			// then choosing gemini-3.8-flash routes to acct-basic (smaller catalog) via reservation.
			await writeFile(
				join(root, "profiles", "acct-pro", "usage.json"),
				JSON.stringify({
					profile: "acct-pro",
					fetchedAt: Date.now(),
					windows: [
						{ family: "gemini", window: "weekly", remainingPct: 95, resetsAt: "2099-01-01T00:00:00Z" },
						{ family: "gemini", window: "fiveHour", remainingPct: 95, resetsAt: "2099-01-01T00:00:00Z" },
					],
					raw: "",
				}),
			);
			await writeFile(
				join(root, "profiles", "acct-basic", "usage.json"),
				JSON.stringify({
					profile: "acct-basic",
					fetchedAt: Date.now(),
					windows: [
						{ family: "gemini", window: "weekly", remainingPct: 80, resetsAt: "2099-01-01T00:00:00Z" },
						{ family: "gemini", window: "fiveHour", remainingPct: 80, resetsAt: "2099-01-01T00:00:00Z" },
					],
					raw: "",
				}),
			);
			await writeFile(
				join(root, "profiles", "acct-basic", "models.json"),
				JSON.stringify({
					profile: "acct-basic",
					fetchedAt: Date.now(),
					models: [{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }],
					configOptions: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }],
				}),
			);
			await writeFile(
				join(root, "profiles", "acct-pro", "models.json"),
				JSON.stringify({
					profile: "acct-pro",
					fetchedAt: Date.now(),
					models: [
						{ modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
						{ modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
						{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
					],
					configOptions: [
						{ value: "gemini-4-argon", name: "Gemini 4 Argon" },
						{ value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
						{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
					],
				}),
			);

			const { proxy, send, notifications } = spawnProxy(projectRoot, root, fake, promptLog, undefined, true);
			const choiceValues = (options: unknown[]) => {
				const model = options.find(option => isRecord(option) && option.id === "model") as {
					options: Array<{ value?: string; options?: Array<{ value: string }> }>;
				};
				return model.options.flatMap(option => option.options?.map(choice => choice.value) ?? [option.value]).sort();
			};
			try {
				await send("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "test", version: "1" } });
				const created = await send<{ result: { sessionId: string; configOptions: unknown[] } }>("session/new", {
					cwd: root,
					mcpServers: [],
				});
				const expectedIds = ["gemini-3.8-flash", "gemini-4-argon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-5-flash"];
				expect(choiceValues(created.result.configOptions)).toEqual(expectedIds);

				// Switching to gemini-3.8-flash moves the session from acct-pro to acct-basic;
				// acct-basic's response must still expose the full merged Gemini catalog.
				const switched = await send<{ result: { configOptions: unknown[] } }>("session/set_config_option", {
					sessionId: created.result.sessionId,
					configId: "model",
					value: "gemini-3.8-flash",
				});
				expect(choiceValues(switched.result.configOptions)).toEqual(expectedIds);

				// Follow-up model config change while already bound to acct-basic emits
				// both response configOptions and config_option_update notification with full catalog.
				const stayOnBasic = await send<{ result: { configOptions: unknown[] } }>("session/set_config_option", {
					sessionId: created.result.sessionId,
					configId: "model",
					value: "gemini-3.8-flash",
				});
				expect(choiceValues(stayOnBasic.result.configOptions)).toEqual(expectedIds);

				// Non-model config option change on acct-basic also preserves full model catalog.
				const nonModelSet = await send<{ result: { configOptions: unknown[] } }>("session/set_config_option", {
					sessionId: created.result.sessionId,
					configId: "thinking",
					value: "high",
				});
				expect(choiceValues(nonModelSet.result.configOptions)).toEqual(expectedIds);

				const updates = notifications.flatMap(message => {
					const params = message.params;
					if (!isRecord(params) || !isRecord(params.update) || params.update.sessionUpdate !== "config_option_update") {
						return [];
					}
					return [params.update.configOptions as unknown[]];
				});
				expect(updates.length).toBeGreaterThan(0);
				for (const updateOptions of updates) {
					expect(choiceValues(updateOptions)).toEqual(expectedIds);
				}

				const prompted = await send<{ result?: { stopReason: string }; error?: unknown }>("session/prompt", {
					sessionId: created.result.sessionId,
					prompt: [{ type: "text", text: "Hello flash" }],
				});
				expect(prompted.error).toBeUndefined();
				expect(prompted.result?.stopReason).toBe("end_turn");
				const entries = (await readFile(promptLog, "utf8")).trim().split("\n");
				expect(entries).toEqual(["acct-basic:gemini-3.8-flash"]);
			} finally {
				proxy.kill();
				await proxy.exited.catch(() => {});
				await rm(root, { recursive: true, force: true });
			}
		},
		30_000,
	);
});
