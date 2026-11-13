import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { isRecord } from "../src/acp/guards";
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
      configOptions: isPro ? PRO_CONFIG : BASIC_CONFIG,
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
    }
    send({ jsonrpc: "2.0", id: message.id, result: { configOptions: isPro ? PRO_CONFIG : BASIC_CONFIG } });
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

async function setupTieredEnv() {
	const root = await mkdtemp(join(tmpdir(), "agy-multi-models-acp-"));
	const projectRoot = join(import.meta.dir, "..");
	const fake = join(root, "fake-agy");
	const promptLog = join(root, "prompts.log");

	for (const slug of ["acct-basic", "acct-pro"]) {
		const dir = join(root, "profiles", slug);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "profile.json"), JSON.stringify({ slug, createdAt: new Date().toISOString() }));
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

function spawnProxy(projectRoot: string, root: string, fake: string, promptLog: string) {
	const proxy = Bun.spawn(["bun", "run", join(projectRoot, "src/index.ts"), "acp"], {
		cwd: projectRoot,
		env: { ...process.env, AGY_MULTI_ROOT: root, AGY_BIN: fake, FAKE_AGY_LOG: promptLog },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdin = proxy.stdin!;
	const pending = new Map<number, (message: unknown) => void>();
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
	});
	return { proxy, send };
}

describe("ACP proxy model capability routing", () => {
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
});
