import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
// These tests drive real child processes; the 5 s default flakes on loaded CI runners.
setDefaultTimeout(20_000);

import { isRecord } from "../src/fs-utils";
import { LineReader } from "../src/acp/rpc";

const projectRoot = join(import.meta.dir, "..");

/**
 * Fake official agent. Every process start and every JSON-RPC request is
 * appended to `FAKE_AGY_LOG` together with the HOME it was launched under, so a
 * test can prove which accounts the wrapper authenticated as.
 *
 * `FAKE_AGY_MODE` (quota | banned | auth) makes `session/prompt` fail with the
 * wording the real CLI uses; `FAKE_AGY_FAIL_SLUG` narrows that to one profile.
 * `/usage` always reports full windows so a failure is a generation failure,
 * never a preflight block.
 */
const FAKE_AGY = `#!/usr/bin/env bun
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = Bun.argv.slice(2);
const home = process.env.HOME ?? "";
const log = process.env.FAKE_AGY_LOG;
const record = entry => {
  if (log) appendFileSync(log, JSON.stringify({ home, ...entry }) + "\\n");
};

record({ event: "start", argv });

// Sequential-mode detector: an agent process records whether another account's
// agent is still alive at its own startup.
const liveDir = process.env.FAKE_AGY_LIVE_DIR;
if (liveDir && argv.includes("acp")) {
  try {
    for (const entry of readdirSync(liveDir)) {
      const pid = Number(entry);
      if (!Number.isFinite(pid) || pid === process.pid) continue;
      let otherHome = "";
      try { otherHome = readFileSync(join(liveDir, entry), "utf8"); } catch {}
      if (otherHome === home) continue;
      try { process.kill(pid, 0); record({ event: "overlap", otherPid: pid, otherHome }); } catch {}
    }
    writeFileSync(join(liveDir, String(process.pid)), home);
  } catch {}
}

if (argv.includes("/usage")) {
  const bySlug = JSON.parse(process.env.FAKE_AGY_USAGE_BY_SLUG ?? "{}");
  const slug = Object.keys(bySlug).find(key => home.includes("/" + key + "/"));
  const pct = Array.isArray(bySlug[slug]) ? bySlug[slug] : [100, 100, 100, 100];
  process.stdout.write(JSON.stringify({
    status: "SUCCESS",
    response: [
      "Gemini Models\\tWeekly Limit Remaining\\t" + pct[0] + "%\\t2099-01-01T00:00:00Z",
      "Gemini Models\\tFive Hour Limit Remaining\\t" + pct[1] + "%\\t2099-01-01T00:00:00Z",
      "Claude and GPT models\\tWeekly Limit Remaining\\t" + pct[2] + "%\\t2099-01-01T00:00:00Z",
      "Claude and GPT models\\tFive Hour Limit Remaining\\t" + pct[3] + "%\\t2099-01-01T00:00:00Z",
    ].join("\\n"),
  }) + "\\n");
  process.exit(0);
}

if (argv.includes("models")) {
  process.stdout.write("gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n");
  process.exit(0);
}

if (argv[0] !== "acp") {
  process.stderr.write("unexpected args: " + argv.join(" ") + "\\n");
  process.exit(2);
}

const failures = {
  quota: "RESOURCE_EXHAUSTED: quota exceeded",
  banned: "Your account is disabled: violation of Terms of Service",
  auth: "not logged into Antigravity; authentication required",
};
const mode = process.env.FAKE_AGY_MODE ?? "ok";
const failSlug = process.env.FAKE_AGY_FAIL_SLUG ?? "";
const mayFail = Object.hasOwn(failures, mode) && (!failSlug || home.includes("/" + failSlug + "/"));

let sequence = 0;
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message.method !== "string") return;
  const params = message.params ?? {};
  record({ event: "request", method: message.method, sessionId: params.sessionId, ...(message.method === "session/prompt" ? { text: params.prompt?.[0]?.text } : {}) });
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, load: {}, resume: {}, close: {} } },
      agentInfo: { name: "fake-agy", version: "1.0.0" },
      authMethods: [],
    }});
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      sessionId: "fake-session-" + (++sequence),
      models: { currentModelId: "gemini-3.8-flash-high", availableModels: [] },
    }});
    return;
  }
  if (message.method === "session/prompt") {
    const holdSlug = process.env.FAKE_AGY_HOLD_HOME;
    if (holdSlug && home.includes("/" + holdSlug + "/")) {
      record({ event: "held", method: "session/prompt", sessionId: params.sessionId });
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "HOLDING " + params.sessionId } },
      }});
      return;
    }
    if (mayFail) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: failures[mode] } });
      return;
    }
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } },
    }});
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (message.method === "session/load" || message.method === "session/resume" || message.method === "session/close" || message.method === "session/set_model") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported: " + message.method } });
});
`;

interface Invocation {
	home: string;
	event: "start" | "request" | "overlap" | "held";
	argv?: string[];
	method?: string;
	sessionId?: string;
	text?: string;
	otherPid?: number;
	otherHome?: string;
}

interface Reply {
	result?: {
		protocolVersion?: number;
		sessionId?: string;
		stopReason?: string;
		agentCapabilities?: Record<string, unknown>;
	};
	error?: { code: number; message: string };
}

interface ProxyClient {
	proxy: Bun.Subprocess;
	send: <T extends Reply>(method: string, params: unknown) => Promise<T>;
	notify: (method: string, params: unknown) => Promise<void>;
	notifications: unknown[];
	stderrLines: string[];
	waitForStderr: (predicate: (line: string) => boolean, timeoutMs?: number) => Promise<void>;
	waitForNotification: (predicate: (message: unknown) => boolean, timeoutMs?: number) => Promise<unknown>;
}

function collectLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): void {
	const decoder = new TextDecoder();
	let buffer = "";
	void (async () => {
		const reader = stream.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let index = buffer.indexOf("\n");
				while (index >= 0) {
					onLine(buffer.slice(0, index));
					buffer = buffer.slice(index + 1);
					index = buffer.indexOf("\n");
				}
			}
			if (buffer) onLine(buffer);
		} catch {
			// The pipe closed; whatever was read is already reported.
		}
	})();
}

async function fixture(
	slugs: string[],
	options: { agent?: string; env?: Record<string, string> } = {},
) {
	const root = await mkdtemp(join(tmpdir(), "agy-multi-acp-"));
	const fake = join(root, "fake-agy");
	const log = join(root, "invocations.jsonl");
	await writeFile(fake, options.agent ?? FAKE_AGY);
	await chmod(fake, 0o755);
	for (const slug of slugs) {
		const dir = join(root, "profiles", slug);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "profile.json"), JSON.stringify({ slug, createdAt: new Date().toISOString() }));
	}
	const baseEnv = { ...process.env, AGY_MULTI_ROOT: root, AGY_BIN: fake, FAKE_AGY_LOG: log, ...options.env };

	const invocations = async (): Promise<Invocation[]> => {
		try {
			const text = await readFile(log, "utf8");
			return text
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as Invocation);
		} catch {
			return [];
		}
	};

	/** One-shot CLI invocation (no long-lived JSON-RPC session). */
	const cli = async (args: string[]) => {
		const proc = Bun.spawn(["bun", "run", join(projectRoot, "src/index.ts"), ...args], {
			cwd: projectRoot,
			env: baseEnv,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, exitCode };
	};

	/** A wrapper ACP process speaking JSON-RPC over stdio to the test client. */
	const proxy = (args: string[], env: Record<string, string> = {}): ProxyClient => {
		const child = Bun.spawn(["bun", "run", join(projectRoot, "src/index.ts"), "acp", ...args], {
			cwd: projectRoot,
			env: { ...baseEnv, ...env },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdin = child.stdin;
		const stdout = child.stdout;
		const stderr = child.stderr;
		if (!stdin || !stdout || !stderr) throw new Error("proxy stdio missing");

		const pending = new Map<number, (message: unknown) => void>();
		const notifications: unknown[] = [];
		const notificationWaiters: {
			predicate: (message: unknown) => boolean;
			resolve: (message: unknown) => void;
		}[] = [];
		let nextId = 1;

		new LineReader(stdout, line => {
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
				return;
			}
			notifications.push(message);
			for (const waiter of [...notificationWaiters]) {
				if (!waiter.predicate(message)) continue;
				notificationWaiters.splice(notificationWaiters.indexOf(waiter), 1);
				waiter.resolve(message);
			}
		});

		const stderrLines: string[] = [];
		const stderrWaiters: { predicate: (line: string) => boolean; resolve: () => void }[] = [];
		collectLines(stderr, line => {
			stderrLines.push(line);
			for (const waiter of [...stderrWaiters]) {
				if (!waiter.predicate(line)) continue;
				stderrWaiters.splice(stderrWaiters.indexOf(waiter), 1);
				waiter.resolve();
			}
		});

		const send = async <T extends Reply>(method: string, params: unknown): Promise<T> => {
			const id = nextId++;
			const { promise, resolve } = Promise.withResolvers<unknown>();
			pending.set(id, resolve);
			stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			await stdin.flush();
			return (await promise) as T;
		};

		const notify = async (method: string, params: unknown) => {
			stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
			await stdin.flush();
		};

		const waitForStderr = (predicate: (line: string) => boolean, timeoutMs = 10_000): Promise<void> => {
			if (stderrLines.some(predicate)) return Promise.resolve();
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const timer = setTimeout(() => {
				reject(new Error(`timed out waiting for stderr; saw: ${stderrLines.join(" | ") || "(nothing)"}`));
			}, timeoutMs);
			stderrWaiters.push({
				predicate,
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
			});
			return promise;
		};

		const waitForNotification = (predicate: (message: unknown) => boolean, timeoutMs = 10_000): Promise<unknown> => {
			const seen = notifications.find(predicate);
			if (seen !== undefined) return Promise.resolve(seen);
			const { promise, resolve, reject } = Promise.withResolvers<unknown>();
			const timer = setTimeout(() => {
				reject(new Error("timed out waiting for a proxy notification"));
			}, timeoutMs);
			notificationWaiters.push({
				predicate,
				resolve: message => {
					clearTimeout(timer);
					resolve(message);
				},
			});
			return promise;
		};

		return { proxy: child, send, notify, notifications, stderrLines, waitForStderr, waitForNotification };
	};

	const cleanup = async () => {
		await rm(root, { recursive: true, force: true });
	};

	return { root, invocations, cli, proxy, cleanup };
}

async function stop(client: ProxyClient): Promise<void> {
	client.proxy.kill();
	await client.proxy.exited.catch(() => {});
}

function homeOf(root: string, slug: string): string {
	return join(root, "profiles", slug, "home");
}

/** Agent HOMEs that received a `session/prompt`, in order. */
function promptHomes(invocations: Invocation[]): string[] {
	return invocations.filter(entry => entry.method === "session/prompt").map(entry => entry.home);
}

/** Seeds a profile's cached `/usage` and model catalog, as a refresh would have. */
async function seedProfile(
	root: string,
	slug: string,
	options: { usagePct?: number; models?: string[] } = {},
): Promise<void> {
	const dir = join(root, "profiles", slug);
	const fetchedAt = Date.now();
	if (options.usagePct !== undefined) {
		await writeFile(
			join(dir, "usage.json"),
			JSON.stringify({
				profile: slug,
				fetchedAt,
				windows: [
					{ family: "gemini", window: "fiveHour", remainingPct: options.usagePct, resetsAt: "2099-01-01T00:00:00Z" },
					{ family: "gemini", window: "weekly", remainingPct: options.usagePct, resetsAt: "2099-01-01T00:00:00Z" },
				],
				raw: "",
			}),
		);
	}
	if (options.models) {
		await writeFile(
			join(dir, "models.json"),
			JSON.stringify({ profile: slug, fetchedAt, models: options.models.map(modelId => ({ modelId })) }),
		);
	}
}

describe("agy-multi ACP proxy (account pool default)", () => {
	test(
		"account pool is the default and starts quietly without blocking initialize",
		async () => {
			const f = await fixture(["acct-a", "acct-b"]);
			const client = f.proxy([]);
			try {
				await client.waitForStderr(line => line.includes("ready —"));
				expect(client.stderrLines.join("\n")).toContain("mode: pool");
				expect(client.stderrLines.join("\n")).not.toContain("Terms of Service");

				const initialized = await client.send<Reply>("initialize", {
					protocolVersion: 1,
					clientCapabilities: {},
				});
				expect(initialized.result?.protocolVersion).toBe(1);
			} finally {
				await stop(client);
				await f.cleanup();
			}
		},
		30_000,
	);

	test(
		"default account pool completes a quota-blocked turn on the next account",
		async () => {
			const f = await fixture(["acct-a", "acct-b"], {
				env: { FAKE_AGY_MODE: "quota", FAKE_AGY_FAIL_SLUG: "acct-a" },
			});
			const client = f.proxy(["--switch-delay", "0"]);
			try {
				await client.send<Reply>("initialize", { protocolVersion: 1, clientCapabilities: {} });
				const created = await client.send<Reply>("session/new", { cwd: f.root, mcpServers: [] });
				const sessionId = created.result?.sessionId;
				const prompted = await client.send<Reply>("session/prompt", {
					sessionId,
					prompt: [{ type: "text", text: "TRIGGER" }],
				});

				expect(prompted.error).toBeUndefined();
				expect(prompted.result?.stopReason).toBe("end_turn");

				const invocations = await f.invocations();
				expect(promptHomes(invocations)).toEqual([homeOf(f.root, "acct-a"), homeOf(f.root, "acct-b")]);

				const state = JSON.parse(await readFile(join(f.root, "state.json"), "utf8")) as {
					version?: number;
					blocks: Record<string, { gemini?: number }>;
				};
				expect(state.version).toBe(2);
				expect(state.blocks["acct-a"]?.gemini).toBeGreaterThan(Date.now());

				let answeredSession: unknown;
				for (const message of client.notifications) {
					if (!isRecord(message) || message.method !== "session/update" || !isRecord(message.params)) continue;
					const params = message.params;
					if (!isRecord(params.update) || !isRecord(params.update.content)) continue;
					if (params.update.content.text !== "OK") continue;
					answeredSession = params.sessionId;
					break;
				}
				expect(answeredSession).toBe(sessionId);
			} finally {
				await stop(client);
				await f.cleanup();
			}
		},
		30_000,
	);

	test(
		"default account pool paces the handoff to the next account",
		async () => {
			const f = await fixture(["acct-a", "acct-b"], {
				env: { FAKE_AGY_MODE: "quota", FAKE_AGY_FAIL_SLUG: "acct-a" },
			});
			const client = f.proxy(["--switch-delay", "1"]);
			try {
				await client.send<Reply>("initialize", { protocolVersion: 1, clientCapabilities: {} });
				const created = await client.send<Reply>("session/new", { cwd: f.root, mcpServers: [] });
				const startedAt = Date.now();
				const prompted = await client.send<Reply>("session/prompt", {
					sessionId: created.result?.sessionId,
					prompt: [{ type: "text", text: "TRIGGER" }],
				});
				const elapsed = Date.now() - startedAt;

				// The pause must not swallow the handoff: the turn still completes on the
				// next account, one second later.
				expect(prompted.error).toBeUndefined();
				expect(prompted.result?.stopReason).toBe("end_turn");
				expect(elapsed).toBeGreaterThanOrEqual(900);
				expect(promptHomes(await f.invocations())).toEqual([
					homeOf(f.root, "acct-a"),
					homeOf(f.root, "acct-b"),
				]);
			} finally {
				await stop(client);
				await f.cleanup();
			}
		},
		30_000,
	);

	test(
		"pool mode continues the same conversation on the next account instead of replaying it",
		async () => {
			const f = await fixture(["acct-a", "acct-b"], {
				env: { FAKE_AGY_MODE: "quota", FAKE_AGY_FAIL_SLUG: "acct-a" },
			});
			const client = f.proxy(["--switch-delay", "0"]);
			try {
				const created = await client.send<Reply>("session/new", { cwd: f.root, mcpServers: [] });
				const prompted = await client.send<Reply>("session/prompt", {
					sessionId: created.result?.sessionId,
					prompt: [{ type: "text", text: "KEEP THIS THREAD" }],
				});
				expect(prompted.error).toBeUndefined();

				const invocations = await f.invocations();
				const firstPrompt = invocations.find(
					entry => entry.method === "session/prompt" && entry.home === homeOf(f.root, "acct-a"),
				);
				const resumed = invocations.find(
					entry => entry.method === "session/resume" && entry.home === homeOf(f.root, "acct-b"),
				);
				// The shared store lets the second account open the same conversation.
				expect(resumed?.sessionId).toBe(firstPrompt?.sessionId);

				const continued = invocations.filter(
					entry => entry.method === "session/prompt" && entry.home === homeOf(f.root, "acct-b"),
				);
				expect(continued).toHaveLength(1);
				// The account switch carries the thread, so no transcript is replayed.
				expect(continued[0]?.text).toBe("KEEP THIS THREAD");
				expect(invocations.filter(entry => entry.method === "session/new")).toHaveLength(1);
			} finally {
				await stop(client);
				await f.cleanup();
			}
		},
		30_000,
	);

	test(
		"sequential mode never runs two accounts at once and never probes the idle one",
		async () => {
			const liveDir = await mkdtemp(join(tmpdir(), "agy-live-"));
			const f = await fixture(["acct-a", "acct-b"], {
				env: { FAKE_AGY_MODE: "quota", FAKE_AGY_FAIL_SLUG: "acct-a", FAKE_AGY_LIVE_DIR: liveDir },
			});
			const client = f.proxy(["--sequential", "--switch-delay", "0"]);
			try {
				await client.send<Reply>("initialize", { protocolVersion: 1, clientCapabilities: {} });
				const created = await client.send<Reply>("session/new", { cwd: f.root, mcpServers: [] });
				const prompted = await client.send<Reply>("session/prompt", {
					sessionId: created.result?.sessionId,
					prompt: [{ type: "text", text: "TRIGGER" }],
				});

				expect(prompted.error).toBeUndefined();
				expect(prompted.result?.stopReason).toBe("end_turn");

				const invocations = await f.invocations();
				// Every fake agent reports a sibling account's process that is still
				// alive when it starts. Sequential mode must produce none of those.
				expect(invocations.filter(entry => entry.event === "overlap")).toEqual([]);

				// The idle account is never read: its first invocation is the agent
				// itself, not a `/usage` or `models` probe.
				const firstOnB = invocations.find(entry => entry.home === homeOf(f.root, "acct-b"));
				expect(firstOnB?.argv).toContain("acp");

				expect(promptHomes(invocations)).toEqual([
					homeOf(f.root, "acct-a"),
					homeOf(f.root, "acct-b"),
				]);
			} finally {
				await stop(client);
				await f.cleanup();
				await rm(liveDir, { recursive: true, force: true });
			}
		},
		30_000,
	);

	test(
		"sequential mode refuses to switch accounts while one is mid-turn",
		async () => {
			const f = await fixture(["acct-a", "acct-b"], { env: { FAKE_AGY_HOLD_HOME: "acct-a" } });
			// acct-a is the healthy one (so the first session lands there); only
			// acct-b can serve the newer model.
			await seedProfile(f.root, "acct-a", { usagePct: 90, models: ["gemini-3.8-flash-high"] });
			await seedProfile(f.root, "acct-b", {
				usagePct: 5,
				models: ["gemini-3.8-flash-high", "gemini-4-argon-high"],
			});

			const client = f.proxy(["--sequential", "--switch-delay", "0"]);
			try {
				const first = await client.send<Reply>("session/new", { cwd: f.root, mcpServers: [] });
				// Hold a turn on acct-a so a switch would have to kill it.
				void client.send<Reply>("session/prompt", {
					sessionId: first.result?.sessionId,
					prompt: [{ type: "text", text: "LONG" }],
				});
				await client.waitForNotification(message => JSON.stringify(message).includes("HOLDING"));

				const second = await client.send<Reply>("session/new", { cwd: f.root, mcpServers: [] });
				const switched = await client.send<Reply>("session/set_model", {
					sessionId: second.result?.sessionId,
					modelId: "gemini-4-argon-high",
				});

				expect(switched.error?.message).toContain("mid-turn");
				const agentStartsOnA = (await f.invocations()).filter(
					entry =>
						entry.event === "start" && entry.home === homeOf(f.root, "acct-a") && entry.argv?.includes("acp"),
				);
				expect(agentStartsOnA).toHaveLength(1);
			} finally {
				await stop(client);
				await f.cleanup();
			}
		},
		30_000,
	);

	test(
		"sequential mode runs a second session on the same account with another model",
		async () => {
			const f = await fixture(["acct-pro", "acct-basic"], { env: { FAKE_AGY_HOLD_HOME: "acct-pro" } });

			// The pro account owns the wider catalog, so in pool mode it is reserved
			// for its own models and must not burn quota on one basic can serve.
			await seedProfile(f.root, "acct-pro", {
				usagePct: 90,
				models: ["gemini-3.8-flash-high", "gemini-4-argon-high", "gemini-4-argon-low"],
			});
			await seedProfile(f.root, "acct-basic", { usagePct: 60, models: ["gemini-3.8-flash-high"] });

			const client = f.proxy(["--sequential", "--switch-delay", "0"]);
			try {
				const main = await client.send<Reply>("session/new", { cwd: f.root, mcpServers: [] });
				const mainOnArgon = await client.send<Reply>("session/set_model", {
					sessionId: main.result?.sessionId,
					modelId: "gemini-4-argon-high",
				});
				expect(mainOnArgon.error).toBeUndefined();

				void client.send<Reply>("session/prompt", {
					sessionId: main.result?.sessionId,
					prompt: [{ type: "text", text: "ORCHESTRATE" }],
				});
				await client.waitForNotification(message => JSON.stringify(message).includes("HOLDING"));

				const subagent = await client.send<Reply>("session/new", { cwd: f.root, mcpServers: [] });
				expect(subagent.error).toBeUndefined();
				// Reservation is a pool-only contest: the live account serves flash
				// itself, so the subagent runs while the argon turn is still going.
				const subagentOnFlash = await client.send<Reply>("session/set_model", {
					sessionId: subagent.result?.sessionId,
					modelId: "gemini-3.8-flash-high",
				});
				expect(subagentOnFlash.error).toBeUndefined();
				void client.send<Reply>("session/prompt", {
					sessionId: subagent.result?.sessionId,
					prompt: [{ type: "text", text: "SUBAGENT" }],
				});

				// Two sessions, two models, one account, both turns in flight at once.
				const firstHold = JSON.stringify(
					await client.waitForNotification(message => JSON.stringify(message).includes("HOLDING ")),
				);
				await client.waitForNotification(message => {
					const text = JSON.stringify(message);
					return text.includes("HOLDING ") && text !== firstHold;
				});

				const holds = (await f.invocations()).filter(entry => entry.event === "held");
				expect(holds.map(entry => entry.home)).toEqual([
					homeOf(f.root, "acct-pro"),
					homeOf(f.root, "acct-pro"),
				]);
				expect(new Set(holds.map(entry => entry.sessionId)).size).toBe(2);
				const basicTouched = (await f.invocations()).filter(entry => entry.home === homeOf(f.root, "acct-basic"));
				expect(basicTouched).toEqual([]);
			} finally {
				await stop(client);
				await f.cleanup();
			}
		},
		30_000,
	);

	test(
		"pool mode serves a reserved model when the account that owns it is blocked",
		async () => {
			const f = await fixture(["acct-pro", "acct-basic"]);
			await seedProfile(f.root, "acct-pro", {
				usagePct: 90,
				models: ["gemini-3.8-flash-high", "gemini-4-argon-high", "gemini-4-argon-low"],
			});
			await seedProfile(f.root, "acct-basic", { usagePct: 90, models: ["gemini-3.8-flash-high"] });
			// The basic account burned its Gemini quota, so it cannot take flash.
			await writeFile(
				join(f.root, "state.json"),
				JSON.stringify({
					version: 2,
					pins: {},
					blocks: { "acct-basic": { gemini: Date.now() + 3_600_000 } },
					checkpoints: {},
				}),
			);

			const client = f.proxy([]);
			try {
				const session = await client.send<Reply>("session/new", { cwd: f.root, mcpServers: [] });
				expect(session.error).toBeUndefined();
				// Reservation must not outlive the account it protects: with the basic
				// account blocked, the pro catalog is the only way to run flash at all.
				const switched = await client.send<Reply>("session/set_model", {
					sessionId: session.result?.sessionId,
					modelId: "gemini-3.8-flash-high",
				});
				expect(switched.error).toBeUndefined();
				const basicTouched = (await f.invocations()).filter(entry => entry.home === homeOf(f.root, "acct-basic"));
				expect(basicTouched).toEqual([]);
			} finally {
				await stop(client);
				await f.cleanup();
			}
		},
		30_000,
	);

	test(
		"sequential mode parks a new session on the account that is mid-turn",
		async () => {
			const slugs = ["acct-a", "acct-b", "acct-c", "acct-d"];
			const f = await fixture(slugs, { env: { FAKE_AGY_HOLD_HOME: "acct-a" } });

			// acct-a leads the ranking, so the first session lands there.
			await seedProfile(f.root, "acct-a", { usagePct: 90 });
			for (const slug of slugs.slice(1)) await seedProfile(f.root, slug, { usagePct: 5 });

			const client = f.proxy(["--sequential", "--switch-delay", "0"]);
			try {
				const first = await client.send<Reply>("session/new", { cwd: f.root, mcpServers: [] });
				expect(first.error).toBeUndefined();
				void client.send<Reply>("session/prompt", {
					sessionId: first.result?.sessionId,
					prompt: [{ type: "text", text: "LONG" }],
				});
				await client.waitForNotification(message => JSON.stringify(message).includes("HOLDING"));

				// Quota drops mid-turn: every other account now outranks acct-a, and
				// three of them fill the candidate window a switch would try.
				await seedProfile(f.root, "acct-a", { usagePct: 5 });
				for (const slug of slugs.slice(1)) await seedProfile(f.root, slug, { usagePct: 90 });

				const second = await client.send<Reply>("session/new", { cwd: f.root, mcpServers: [] });
				expect(second.error).toBeUndefined();
				expect(second.result?.sessionId).toBeTruthy();

				const newSessionsPerHome = (await f.invocations())
					.filter(entry => entry.event === "request" && entry.method === "session/new")
					.map(entry => entry.home);
				expect(newSessionsPerHome).toEqual([homeOf(f.root, "acct-a"), homeOf(f.root, "acct-a")]);
			} finally {
				await stop(client);
				await f.cleanup();
			}
		},
		30_000,
	);
});

/**
 * Reproduces the reported failure: the agent launches a long build as a daemon
 * task, the 10s wait expires, and it closes the turn claiming it is "waiting".
 * `manage_task status` only reports the task finished on the third poll.
 */
const FAKE_DAEMON_AGY = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.FAKE_DAEMON_LOG;
const timerSeconds = Number(process.env.FAKE_DAEMON_TIMER ?? "0.05");
let polls = 0;
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
const lines = createInterface({ input: process.stdin });

lines.on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: "fake-daemon-agy", version: "1.0.0" },
      authMethods: [],
    }});
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      sessionId: "daemon-session",
      models: { currentModelId: "gemini-3.8-flash", availableModels: [] },
    }});
    return;
  }
  if (message.method === "session/prompt") {
    const text = (message.params.prompt ?? []).map(p => p.text ?? "").join("\\n");
    const resuming = text.includes("background tasks were still running");
    if (log) appendFileSync(log, (resuming ? "HOLD" : "PROMPT") + "\\n");

    if (!resuming) {
      // First turn: report the daemon task, then close the turn like the real agent did.
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-817",
          title: "Run schedule",
          status: "completed",
          rawInput: { DurationSeconds: timerSeconds, TimerCondition: "conv/task-817" },
        },
      }});
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: message.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I am waiting for cargo xtask ci (task-817)." } },
      }});
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    // Continuation: re-arm the runtime timer, then poll. Reports running twice, then finishes.
    polls += 1;
    const running = polls < 3;
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: message.params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "timer-" + polls,
        title: "Run schedule",
        status: "completed",
        rawInput: { DurationSeconds: timerSeconds, TimerCondition: "conv/task-817" },
      },
    }});
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: message.params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "poll-" + polls,
        title: "Run manage_task",
        status: "completed",
        rawInput: running
          ? { Action: "status", TaskId: "conv/task-817" }
          : { Action: "kill", TaskId: "conv/task-817" },
      },
    }});
    if (running) {
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: message.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "CI finished: 1902 passed, 1 failed." } },
    }});
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (message.method === "session/set_model" || message.method === "session/close" || message.method === "session/load" || message.method === "session/resume") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported: " + message.method } });
});
`;

function isToolCallNotification(message: unknown, toolCallId: string): boolean {
	if (!isRecord(message) || message.method !== "session/update" || !isRecord(message.params)) return false;
	const update = message.params.update;
	return isRecord(update) && update.toolCallId === toolCallId;
}

describe("agy-multi ACP proxy (daemon tasks and /multi-usage)", () => {
	test(
		"holds the turn open while a daemon task is still running instead of reporting end_turn",
		async () => {
			const f = await fixture(["acct-1"], { agent: FAKE_DAEMON_AGY });
			const turnsLog = join(f.root, "turns.log");
			const client = f.proxy([], { FAKE_DAEMON_LOG: turnsLog });
			try {
				await client.send<Reply>("initialize", { protocolVersion: 1, clientCapabilities: {} });
				const created = await client.send<Reply>("session/new", { cwd: f.root, mcpServers: [] });

				// The reported bug: this resolved with end_turn while the daemon was alive.
				const prompted = await client.send<Reply>("session/prompt", {
					sessionId: created.result?.sessionId,
					prompt: [{ type: "text", text: "run cargo xtask ci" }],
				});

				// Only the proxy asked the agent to resume: once it did, the task was finished.
				expect(prompted.result?.stopReason).toBe("end_turn");
				const turns = (await readFile(turnsLog, "utf8")).trim().split("\n");
				expect(turns[0]).toBe("PROMPT");
				expect(turns.filter(turn => turn === "HOLD").length).toBeGreaterThanOrEqual(2);
			} finally {
				await stop(client);
				await f.cleanup();
			}
		},
		30_000,
	);

	test(
		"cancel during the hold releases the turn and reports cancelled",
		async () => {
			const f = await fixture(["acct-1"], { agent: FAKE_DAEMON_AGY });
			const turnsLog = join(f.root, "turns.log");
			// Long enough that the turn is still held when the client cancels.
			const client = f.proxy([], {
				FAKE_DAEMON_LOG: turnsLog,
				FAKE_DAEMON_TIMER: "30",
			});
			try {
				await client.send<Reply>("initialize", { protocolVersion: 1, clientCapabilities: {} });
				const created = await client.send<Reply>("session/new", { cwd: f.root, mcpServers: [] });
				const sessionId = created.result?.sessionId;

				// Do not await: the turn is held, so only cancel can release it.
				const inflight = client.send<Reply>("session/prompt", {
					sessionId,
					prompt: [{ type: "text", text: "run cargo xtask ci" }],
				});
				// The first tool_call proves the prompt reached the agent and is held.
				await client.waitForNotification(message => isToolCallNotification(message, "call-817"));
				await client.notify("session/cancel", { sessionId });

				const prompted = await inflight;
				expect(prompted.result?.stopReason).toBe("cancelled");
				const turns = (await readFile(turnsLog, "utf8")).trim().split("\n");
				expect(turns.filter(turn => turn === "HOLD")).toEqual([]);
			} finally {
				await stop(client);
				await f.cleanup();
			}
		},
		30_000,
	);

	test(
		"/multi-usage averages quota across active accounts in the pool",
		async () => {
			const f = await fixture(["acct-a", "acct-b"], {
				env: {
					FAKE_AGY_USAGE_BY_SLUG: JSON.stringify({
						"acct-a": [60, 80, 20, 40],
						"acct-b": [80, 100, 40, 60],
					}),
				},
			});
			const now = Date.now();
			const profiles = [
				{ slug: "acct-a", g5: 80, gw: 60, c5: 40, cw: 20 },
				{ slug: "acct-b", g5: 100, gw: 80, c5: 60, cw: 40 },
			];
			for (const profile of profiles) {
				await writeFile(
					join(f.root, "profiles", profile.slug, "usage.json"),
					JSON.stringify({
						profile: profile.slug,
						fetchedAt: now,
						windows: [
							{ family: "gemini", window: "fiveHour", remainingPct: profile.g5, resetsAt: "2099-01-01T00:00:00Z" },
							{ family: "gemini", window: "weekly", remainingPct: profile.gw, resetsAt: "2099-01-01T00:00:00Z" },
							{ family: "claude-gpt", window: "fiveHour", remainingPct: profile.c5, resetsAt: "2099-01-01T00:00:00Z" },
							{ family: "claude-gpt", window: "weekly", remainingPct: profile.cw, resetsAt: "2099-01-01T00:00:00Z" },
						],
						raw: "",
					}),
				);
			}

			const client = f.proxy([]);
			try {
				const chunks: string[] = [];
				const advertised: string[] = [];
				const notifications = client.notifications;
				await client.send<Reply>("initialize", { protocolVersion: 1, clientCapabilities: {} });
				const created = await client.send<Reply>("session/new", { cwd: f.root, mcpServers: [] });
				const sessionId = created.result?.sessionId;

				const prompted = await client.send<Reply>("session/prompt", {
					sessionId,
					prompt: [{ type: "text", text: "/multi-usage" }],
				});
				expect(prompted.result?.stopReason).toBe("end_turn");

				for (const message of notifications) {
					if (!isRecord(message) || message.method !== "session/update" || !isRecord(message.params)) continue;
					const params = message.params;
					if (!isRecord(params.update)) continue;
					if (params.update.sessionUpdate === "available_commands_update" && Array.isArray(params.update.availableCommands)) {
						for (const command of params.update.availableCommands) {
							if (isRecord(command) && typeof command.name === "string") advertised.push(command.name);
						}
					}
					if (!isRecord(params.update.content)) continue;
					if (typeof params.update.content.text === "string") chunks.push(params.update.content.text);
				}
				expect(advertised).toContain("multi-usage");
				expect(chunks.join("")).toBe(
					[
						"Gemini Models\tWeekly Limit Remaining\t70%\t2099-01-01T00:00:00Z",
						"Gemini Models\tFive Hour Limit Remaining\t90%\t2099-01-01T00:00:00Z",
						"Claude and GPT models\tWeekly Limit Remaining\t30%\t2099-01-01T00:00:00Z",
						"Claude and GPT models\tFive Hour Limit Remaining\t50%\t2099-01-01T00:00:00Z",
					].join("\n"),
				);
			} finally {
				await stop(client);
				await f.cleanup();
			}
		},
		30_000,
	);
});

describe("agy-multi ACP proxy (session/fork fallback)", () => {
	test(
		"advertises sessionCapabilities.fork and falls back to session/new + full transcript replay on -32601",
		async () => {
			const f = await fixture(["acct-a"]);
			// Use a tiny --handoff-context cap to verify emulated forks still replay full history.
			const client = f.proxy(["--handoff-context", "30"]);
			try {
				const initialized = await client.send<Reply>("initialize", {
					protocolVersion: 1,
					clientCapabilities: {},
				});
				expect(initialized.error).toBeUndefined();
				const capabilities = initialized.result?.agentCapabilities;
				expect(isRecord(capabilities)).toBe(true);
				const sessionCaps = isRecord(capabilities?.sessionCapabilities)
					? capabilities.sessionCapabilities
					: undefined;
				expect(sessionCaps?.fork).toEqual({});
				expect(sessionCaps?.list).toEqual({});
				expect(sessionCaps?.resume).toEqual({});

				const created = await client.send<Reply>("session/new", {
					cwd: f.root,
					mcpServers: [],
					additionalDirectories: [f.root],
				});
				expect(created.error).toBeUndefined();
				const sourceId = created.result?.sessionId;
				expect(sourceId).toBeTruthy();

				const originalPrompt = "ORIGINAL HISTORY ".repeat(4).trim();
				const firstTurn = await client.send<Reply>("session/prompt", {
					sessionId: sourceId,
					prompt: [{ type: "text", text: originalPrompt }],
				});
				expect(firstTurn.error).toBeUndefined();
				expect(firstTurn.result?.stopReason).toBe("end_turn");

				const forked = await client.send<Reply>("session/fork", { sessionId: sourceId });
				expect(forked.error).toBeUndefined();
				const forkId = forked.result?.sessionId;
				expect(forkId).toBeTruthy();
				expect(forkId).not.toBe(sourceId);

				// Source session remains usable on its own child session.
				const sourceContinue = await client.send<Reply>("session/prompt", {
					sessionId: sourceId,
					prompt: [{ type: "text", text: "SOURCE CONTINUES" }],
				});
				expect(sourceContinue.error).toBeUndefined();
				expect(sourceContinue.result?.stopReason).toBe("end_turn");

				// Fork's first prompt replays full copied history + new prompt on a fresh child session.
				const forkTurn = await client.send<Reply>("session/prompt", {
					sessionId: forkId,
					prompt: [{ type: "text", text: "NEXT TURN" }],
				});
				expect(forkTurn.error).toBeUndefined();
				expect(forkTurn.result?.stopReason).toBe("end_turn");

				// Subsequent prompt on the fork goes directly without replaying history again.
				const forkSecondTurn = await client.send<Reply>("session/prompt", {
					sessionId: forkId,
					prompt: [{ type: "text", text: "FOLLOW UP" }],
				});
				expect(forkSecondTurn.error).toBeUndefined();

				// Forking a fork also works.
				const nestedFork = await client.send<Reply>("session/fork", { sessionId: forkId });
				expect(nestedFork.error).toBeUndefined();
				const nestedForkId = nestedFork.result?.sessionId;
				expect(nestedForkId).toBeTruthy();
				expect(nestedForkId).not.toBe(sourceId);
				expect(nestedForkId).not.toBe(forkId);

				const nestedTurn = await client.send<Reply>("session/prompt", {
					sessionId: nestedForkId,
					prompt: [{ type: "text", text: "NESTED TURN" }],
				});
				expect(nestedTurn.error).toBeUndefined();

				const prompts = (await f.invocations()).filter(entry => entry.method === "session/prompt");
				expect(prompts).toHaveLength(5);

				const [sourceFirst, sourceSecond, forkFirst, forkSecond, nestedFirst] = prompts;
				expect(sourceFirst?.sessionId).toBe(sourceSecond?.sessionId);
				expect(forkFirst?.sessionId).toBeTruthy();
				expect(forkFirst?.sessionId).not.toBe(sourceFirst?.sessionId);
				expect(forkFirst?.sessionId).toBe(forkSecond?.sessionId);
				expect(forkFirst?.text).toContain(originalPrompt);
				expect(forkFirst?.text).toContain("NEXT TURN");
				expect(forkSecond?.text).toBe("FOLLOW UP");

				expect(nestedFirst?.sessionId).toBeTruthy();
				expect(nestedFirst?.sessionId).not.toBe(sourceFirst?.sessionId);
				expect(nestedFirst?.sessionId).not.toBe(forkFirst?.sessionId);
				expect(nestedFirst?.text).toContain(originalPrompt);
				expect(nestedFirst?.text).toContain("NEXT TURN");
				expect(nestedFirst?.text).toContain("FOLLOW UP");
				expect(nestedFirst?.text).toContain("NESTED TURN");
			} finally {
				await stop(client);
				await f.cleanup();
			}
		},
		30_000,
	);

	test(
		"forks an empty session cleanly on -32601 fallback",
		async () => {
			const f = await fixture(["acct-a"]);
			const client = f.proxy([]);
			try {
				await client.send<Reply>("initialize", { protocolVersion: 1, clientCapabilities: {} });
				const created = await client.send<Reply>("session/new", { cwd: f.root, mcpServers: [] });
				const sourceId = created.result?.sessionId;
				expect(sourceId).toBeTruthy();

				const forked = await client.send<Reply>("session/fork", { sessionId: sourceId });
				expect(forked.error).toBeUndefined();
				const forkId = forked.result?.sessionId;
				expect(forkId).toBeTruthy();
				expect(forkId).not.toBe(sourceId);

				expect(
					(await client.send<Reply>("session/prompt", { sessionId: forkId, prompt: [{ type: "text", text: "FORK FIRST" }] }))
						.error,
				).toBeUndefined();
				expect(
					(await client.send<Reply>("session/prompt", { sessionId: sourceId, prompt: [{ type: "text", text: "SOURCE FIRST" }] }))
						.error,
				).toBeUndefined();

				const prompts = (await f.invocations()).filter(entry => entry.method === "session/prompt");
				expect(prompts).toHaveLength(2);
				expect(prompts[0]?.sessionId).not.toBe(prompts[1]?.sessionId);
				expect(prompts[0]?.text).toContain("FORK FIRST");
				expect(prompts[1]?.text).toBe("SOURCE FIRST");
			} finally {
				await stop(client);
				await f.cleanup();
			}
		},
		30_000,
	);

	test(
		"propagates non--32601 child errors from session/fork unchanged",
		async () => {
			const failingForkAgent = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.FAKE_AGY_LOG;
const record = entry => {
  if (log) appendFileSync(log, JSON.stringify(entry) + "\\n");
};
if (Bun.argv.includes("/usage")) {
  process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "" }) + "\\n");
  process.exit(0);
}
if (Bun.argv.includes("models")) {
  process.stdout.write("gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n");
  process.exit(0);
}
let seq = 0;
const send = msg => process.stdout.write(JSON.stringify(msg) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  record({ event: "request", method: m.method, sessionId: m.params?.sessionId });
  if (m.method === "initialize") {
    return send({ jsonrpc: "2.0", id: m.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
      authMethods: [],
    }});
  }
  if (m.method === "session/new") {
    return send({ jsonrpc: "2.0", id: m.id, result: {
      sessionId: "child-" + (++seq),
      models: { currentModelId: "gemini-3.8-flash-high", availableModels: [] },
    }});
  }
  if (m.method === "session/fork") {
    return send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "RESOURCE_EXHAUSTED: fork quota exceeded" } });
  }
  send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`;
			const f = await fixture(["acct-a"], { agent: failingForkAgent });
			const client = f.proxy([]);
			try {
				await client.send<Reply>("initialize", { protocolVersion: 1, clientCapabilities: {} });
				const created = await client.send<Reply>("session/new", { cwd: f.root, mcpServers: [] });
				const sourceId = created.result?.sessionId;

				const forked = await client.send<Reply>("session/fork", { sessionId: sourceId });
				expect(forked.result).toBeUndefined();
				expect(forked.error).toEqual({
					code: -32000,
					message: "RESOURCE_EXHAUSTED: fork quota exceeded",
				});

				const newRequests = (await f.invocations()).filter(entry => entry.method === "session/new");
				expect(newRequests).toHaveLength(1);
			} finally {
				await stop(client);
				await f.cleanup();
			}
		},
		30_000,
	);

	test(
		"preserves native session/fork fast path and augments snake_case session_capabilities",
		async () => {
			const nativeForkAgent = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.FAKE_AGY_LOG;
const record = entry => {
  if (log) appendFileSync(log, JSON.stringify(entry) + "\\n");
};
if (Bun.argv.includes("/usage")) {
  process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "" }) + "\\n");
  process.exit(0);
}
if (Bun.argv.includes("models")) {
  process.stdout.write("gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n");
  process.exit(0);
}
let seq = 0;
const send = msg => process.stdout.write(JSON.stringify(msg) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  record({
    event: "request",
    method: m.method,
    sessionId: m.params?.sessionId,
    ...(m.method === "session/prompt" ? { text: m.params?.prompt?.[0]?.text } : {}),
  });
  if (m.method === "initialize") {
    return send({ jsonrpc: "2.0", id: m.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, session_capabilities: { list: {} } },
      authMethods: [],
    }});
  }
  if (m.method === "session/new") {
    return send({ jsonrpc: "2.0", id: m.id, result: {
      sessionId: "child-" + (++seq),
      models: { currentModelId: "gemini-3.8-flash-high", availableModels: [] },
    }});
  }
  if (m.method === "session/fork") {
    const forkChildId = "native-fork-" + (++seq);
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: forkChildId,
      update: { sessionUpdate: "session_info_update", title: "Forked Title" },
    }});
    return send({ jsonrpc: "2.0", id: m.id, result: {
      sessionId: forkChildId,
      models: { currentModelId: "gemini-3.8-flash-high", availableModels: [] },
    }});
  }
  if (m.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: m.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } },
    }});
    return send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
  }
  send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`;
			const f = await fixture(["acct-a"], { agent: nativeForkAgent });
			const client = f.proxy([]);
			try {
				const initialized = await client.send<Reply>("initialize", {
					protocolVersion: 1,
					clientCapabilities: {},
				});
				const capabilities = initialized.result?.agentCapabilities;
				const snakeCaps = isRecord(capabilities?.session_capabilities)
					? capabilities.session_capabilities
					: undefined;
				expect(snakeCaps?.fork).toEqual({});
				expect(snakeCaps?.list).toEqual({});

				const created = await client.send<Reply>("session/new", { cwd: f.root, mcpServers: [] });
				const sourceId = created.result?.sessionId;
				await client.send<Reply>("session/prompt", {
					sessionId: sourceId,
					prompt: [{ type: "text", text: "NATIVE SOURCE" }],
				});

				const forked = await client.send<Reply>("session/fork", { sessionId: sourceId });
				expect(forked.error).toBeUndefined();
				const forkId = forked.result?.sessionId;
				expect(forkId).toBeTruthy();
				expect(forkId).not.toBe(sourceId);
				expect(forkId).not.toContain("native-fork-");

				const titleNotice = await client.waitForNotification(
					msg =>
						isRecord(msg) &&
						msg.method === "session/update" &&
						isRecord(msg.params) &&
						msg.params.sessionId === forkId &&
						isRecord(msg.params.update) &&
						msg.params.update.title === "Forked Title",
				);
				expect(titleNotice).toBeDefined();

				await client.send<Reply>("session/prompt", {
					sessionId: forkId,
					prompt: [{ type: "text", text: "NATIVE FOLLOWUP" }],
				});

				const invocations = await f.invocations();
				// Native fast path never fell back to a second session/new.
				expect(invocations.filter(entry => entry.method === "session/new")).toHaveLength(1);
				const prompts = invocations.filter(entry => entry.method === "session/prompt");
				expect(prompts).toHaveLength(2);
				// Native fork does not prepend transcript replay.
				expect(prompts[1]?.text).toBe("NATIVE FOLLOWUP");
				expect(prompts[1]?.sessionId).toContain("native-fork-");
			} finally {
				await stop(client);
				await f.cleanup();
			}
		},
		30_000,
	);
});
