import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { isRecord } from "../src/acp/guards";
import { LineReader } from "../src/acp/rpc";

/**
 * Fake official client. `acct-a` rejects prompts with a quota error; every
 * other profile answers `OK`. `/usage` always reports full windows so the
 * wrapper must rely on the generation failure, not a preflight block.
 */
const FAKE_AGY = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = Bun.argv.slice(2);
const home = process.env.HOME ?? "";
const promptLog = process.env.FAKE_AGY_LOG;
const usageLog = process.env.FAKE_AGY_USAGE_LOG;

if (argv.includes("/usage")) {
  if (usageLog) appendFileSync(usageLog, home + "\\n");
  process.stdout.write(JSON.stringify({
    status: "SUCCESS",
    response: [
      "Gemini Models\\tWeekly Limit Remaining\\t100%\\t2099-01-01T00:00:00Z",
      "Gemini Models\\tFive Hour Limit Remaining\\t100%\\t2099-01-01T00:00:00Z",
      "Claude and GPT models\\tWeekly Limit Remaining\\t100%\\t2099-01-01T00:00:00Z",
      "Claude and GPT models\\tFive Hour Limit Remaining\\t100%\\t2099-01-01T00:00:00Z",
    ].join("\\n"),
  }) + "\\n");
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
lines.on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
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
    const sessionId = "fake-session-" + (++sequence);
    sessions.set(sessionId, { fail: home.includes("acct-a") });
    send({ jsonrpc: "2.0", id: message.id, result: {
      sessionId,
      models: { currentModelId: "gemini-3.8-flash-high", availableModels: [] },
    }});
    return;
  }
  if (message.method === "session/prompt") {
    const session = sessions.get(message.params.sessionId);
    if (promptLog) appendFileSync(promptLog, home + "\\n");
    if (session && session.fail) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "RESOURCE_EXHAUSTED: quota exceeded" } });
      return;
    }
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: message.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } },
    }});
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (message.method === "session/load" || message.method === "session/resume" || message.method === "session/close") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/set_model") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported: " + message.method } });
});
`;

describe("agy-multi ACP proxy", () => {
	test(
		"switches profiles on a quota error and hands the turn to the next account",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "agy-multi-acp-"));
			const projectRoot = join(import.meta.dir, "..");
			const fake = join(root, "fake-agy");
			const promptLog = join(root, "prompts.log");

			for (const slug of ["acct-a", "acct-b"]) {
				const dir = join(root, "profiles", slug);
				await mkdir(dir, { recursive: true });
				await writeFile(join(dir, "profile.json"), JSON.stringify({ slug, createdAt: new Date().toISOString() }));
			}
			await writeFile(fake, FAKE_AGY);
			await chmod(fake, 0o755);

			const proxy = Bun.spawn(["bun", "run", join(projectRoot, "src/index.ts"), "acp"], {
				cwd: projectRoot,
				env: { ...process.env, AGY_MULTI_ROOT: root, AGY_BIN: fake, FAKE_AGY_LOG: promptLog },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});

			try {
				const stdin = proxy.stdin;
				if (!stdin) throw new Error("proxy stdin missing");
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

				const notifications: unknown[] = [];
				new LineReader(proxy.stdout, line => {
					let message: unknown;
					try {
						message = JSON.parse(line);
					} catch {
						return;
					}
					if (
						isRecord(message) &&
						typeof message.id === "number" &&
						pending.has(message.id)
					) {
						const resolve = pending.get(message.id)!;
						pending.delete(message.id);
						resolve(message);
						return;
					}
					notifications.push(message);
				});

				const initialized = await send<{ result: { protocolVersion: number } }>("initialize", {
					protocolVersion: 1,
					clientCapabilities: {},
					clientInfo: { name: "test", version: "1.0.0" },
				});
				expect(initialized.result.protocolVersion).toBe(1);

				const created = await send<{ result: { sessionId: string } }>("session/new", {
					cwd: root,
					mcpServers: [],
				});
				const sessionId = created.result.sessionId;
				expect(typeof sessionId).toBe("string");

				const prompted = await send<{ result: { stopReason: string } }>("session/prompt", {
					sessionId,
					prompt: [{ type: "text", text: "TRIGGER" }],
				});
				expect(prompted.result.stopReason).toBe("end_turn");

				const state = JSON.parse(await readFile(join(root, "state.json"), "utf8")) as {
					blocks: Record<string, { gemini?: number }>;
				};
				expect(state.blocks["acct-a"]?.gemini).toBeGreaterThan(Date.now());

				const homes = (await readFile(promptLog, "utf8")).trim().split("\n");
				expect(homes.length).toBe(2);
				expect(homes[0]).toContain("acct-a");
				expect(homes[1]).toContain("acct-b");

				let matchedSessionId: unknown;
				for (const message of notifications) {
					if (!isRecord(message) || message.method !== "session/update" || !isRecord(message.params)) continue;
					const params = message.params;
					if (!isRecord(params.update) || !isRecord(params.update.content)) continue;
					if (params.update.content.text !== "OK") continue;
					matchedSessionId = params.sessionId;
					break;
				}
				expect(matchedSessionId).toBe(sessionId);
			} finally {
				proxy.kill();
				await proxy.exited.catch(() => {});
				await rm(root, { recursive: true, force: true });
			}
		},
		30_000,
	);

	test(
		"initialize handshake does not invoke blocking /usage preflight",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "agy-multi-acp-fast-"));
			const projectRoot = join(import.meta.dir, "..");
			const fake = join(root, "fake-agy");
			const usageLog = join(root, "usage.log");

			for (const slug of ["acct-1", "acct-2", "acct-3"]) {
				const dir = join(root, "profiles", slug);
				await mkdir(dir, { recursive: true });
				await writeFile(
					join(dir, "profile.json"),
					JSON.stringify({ slug, createdAt: new Date().toISOString() }),
				);
			}

			await writeFile(fake, FAKE_AGY);
			await chmod(fake, 0o755);

			const proxy = Bun.spawn(["bun", "run", join(projectRoot, "src", "index.ts"), "acp"], {
				env: {
					...process.env,
					AGY_MULTI_ROOT: root,
					AGY_BIN: fake,
					FAKE_AGY_USAGE_LOG: usageLog,
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});

			const stdin = proxy.stdin;
			const stdout = proxy.stdout;
			if (!stdin || !stdout) throw new Error("no stdio");

			let seq = 0;
			const pending = new Map<number, (res: unknown) => void>();

			new LineReader(stdout, line => {
				let parsed: unknown;
				try { parsed = JSON.parse(line); } catch { return; }
				if (isRecord(parsed) && typeof parsed.id === "number") {
					const cb = pending.get(parsed.id);
					if (cb) {
						pending.delete(parsed.id);
						cb(parsed);
					}
				}
			});

			function send<T>(method: string, params: unknown): Promise<T> {
				const id = ++seq;
				return new Promise(resolve => {
					pending.set(id, resolve as (res: unknown) => void);
					stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
					stdin.flush();
				});
			}

			try {
				const res = await send<{ result: { protocolVersion: number } }>("initialize", {
					protocolVersion: 1,
					clientCapabilities: {},
				});
				expect(res.result.protocolVersion).toBe(1);

				// Verify usage was never invoked during initialize handshake
				let usageCalls = 0;
				try {
					const usageContent = await readFile(usageLog, "utf8");
					usageCalls = usageContent.trim().split("\n").filter(Boolean).length;
				} catch {
					// File does not exist because no /usage was executed
					usageCalls = 0;
				}
				expect(usageCalls).toBe(0);
			} finally {
				proxy.kill();
				await proxy.exited.catch(() => {});
				await rm(root, { recursive: true, force: true });
			}
		},
		10_000,
	);

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

	test(
		"holds the turn open while a daemon task is still running instead of reporting end_turn",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "agy-multi-daemon-"));
			const projectRoot = join(import.meta.dir, "..");
			const fake = join(root, "fake-agy");
			const log = join(root, "turns.log");

			const dir = join(root, "profiles", "acct-1");
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "profile.json"), JSON.stringify({ slug: "acct-1", createdAt: new Date().toISOString() }));
			await writeFile(fake, FAKE_DAEMON_AGY);
			await chmod(fake, 0o755);

			const proxy = Bun.spawn(["bun", "run", join(projectRoot, "src/index.ts"), "acp"], {
				cwd: projectRoot,
				env: { ...process.env, AGY_MULTI_ROOT: root, AGY_BIN: fake, FAKE_DAEMON_LOG: log },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});

			try {
				const stdin = proxy.stdin;
				if (!stdin) throw new Error("proxy stdin missing");
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

				await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
				const created = await send<{ result: { sessionId: string } }>("session/new", {
					cwd: root,
					mcpServers: [],
				});

				// The reported bug: this resolved with end_turn while the daemon was alive.
				const prompted = await send<{ result: { stopReason: string } }>("session/prompt", {
					sessionId: created.result.sessionId,
					prompt: [{ type: "text", text: "run cargo xtask ci" }],
				});

				// Only the proxy asked the agent to resume: once it did, the task was finished.
				expect(prompted.result.stopReason).toBe("end_turn");
				const turns = (await readFile(log, "utf8")).trim().split("\n");
				expect(turns[0]).toBe("PROMPT");
				expect(turns.filter(turn => turn === "HOLD").length).toBeGreaterThanOrEqual(2);
			} finally {
				proxy.kill();
				await proxy.exited.catch(() => {});
				await rm(root, { recursive: true, force: true });
			}
		},
		30_000,
	);

	test(
		"cancel during the hold releases the turn and reports cancelled",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "agy-multi-daemon-cancel-"));
			const projectRoot = join(import.meta.dir, "..");
			const fake = join(root, "fake-agy");
			const log = join(root, "turns.log");

			const dir = join(root, "profiles", "acct-1");
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "profile.json"), JSON.stringify({ slug: "acct-1", createdAt: new Date().toISOString() }));
			await writeFile(fake, FAKE_DAEMON_AGY);
			await chmod(fake, 0o755);

			const proxy = Bun.spawn(["bun", "run", join(projectRoot, "src/index.ts"), "acp"], {
				cwd: projectRoot,
				env: {
					...process.env,
					AGY_MULTI_ROOT: root,
					AGY_BIN: fake,
					FAKE_DAEMON_LOG: log,
					// Long enough that the assertion runs while the proxy is still holding.
					FAKE_DAEMON_TIMER: "30",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});

			try {
				const stdin = proxy.stdin;
				if (!stdin) throw new Error("proxy stdin missing");
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
				const notify = async (method: string, params: unknown) => {
					stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
					await stdin.flush();
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

				await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
				const created = await send<{ result: { sessionId: string } }>("session/new", {
					cwd: root,
					mcpServers: [],
				});
				const sessionId = created.result.sessionId;

				// Do not await: the proxy is holding the turn, so only cancel can release it.
				const inflight = send<{ result: { stopReason: string } }>("session/prompt", {
					sessionId,
					prompt: [{ type: "text", text: "run cargo xtask ci" }],
				});
				await new Promise(resolve => setTimeout(resolve, 300));
				await notify("session/cancel", { sessionId });

				const prompted = await inflight;
				expect(prompted.result.stopReason).toBe("cancelled");
				const turns = (await readFile(log, "utf8")).trim().split("\n");
				expect(turns.filter(turn => turn === "HOLD")).toEqual([]);
			} finally {
				proxy.kill();
				await proxy.exited.catch(() => {});
				await rm(root, { recursive: true, force: true });
			}
		},
		30_000,
	);
});
