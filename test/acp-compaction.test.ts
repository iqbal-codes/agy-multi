import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { isRecord } from "../src/acp/guards";
import { LineReader } from "../src/acp/rpc";

/**
 * Fake agy harness that writes transcript files to simulate token consumption,
 * and logs all prompts received.
 */
function createFakeAgyScript(options: { failCompact?: boolean } = {}): string {
	return `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = Bun.argv.slice(2);
const home = process.env.HOME ?? "";
const promptLog = process.env.FAKE_AGY_PROMPT_LOG;
const tokenCount = Number.parseInt(process.env.FAKE_AGY_TOKENS ?? "0", 10);
const failCompact = ${options.failCompact ? "true" : "false"};

if (argv.includes("/usage")) {
  process.stdout.write(JSON.stringify({
    status: "SUCCESS",
    response: [
      "Gemini Models\\tWeekly Limit Remaining\\t100%\\t2099-01-01T00:00:00Z",
      "Claude and GPT models\\tWeekly Limit Remaining\\t100%\\t2099-01-01T00:00:00Z",
    ].join("\\n"),
  }) + "\\n");
  process.exit(0);
}

if (argv[0] !== "acp") {
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
    sessions.set(sessionId, true);
    send({ jsonrpc: "2.0", id: message.id, result: {
      sessionId,
      models: { currentModelId: "gemini-3.8-flash-high", availableModels: [] },
    }});
    return;
  }

  if (message.method === "session/prompt") {
    const text = message.params.prompt?.[0]?.text ?? "";
    if (promptLog) appendFileSync(promptLog, text + "\\n");

    const sessionId = message.params.sessionId;
    const brainLogs = join(home, ".gemini", "antigravity-cli", "brain", sessionId, ".system_generated", "logs");
    mkdirSync(brainLogs, { recursive: true });

    if (text === "/compact") {
      if (failCompact) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "compaction failed: out of memory" } });
        return;
      }
      // Compacting reduces token usage to 1000
      writeFileSync(join(brainLogs, "transcript.jsonl"), JSON.stringify({ input_tokens: 800, cache_read_tokens: 200, output_tokens: 50 }) + "\\n");
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Compacted history summary" } },
      }});
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    // Normal prompt simulates high or low tokens
    writeFileSync(join(brainLogs, "transcript.jsonl"), JSON.stringify({ input_tokens: tokenCount, cache_read_tokens: 0, output_tokens: 100 }) + "\\n");
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Normal response" } },
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
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } });
});
`;
}

describe("agy-multi auto-compaction guard", () => {
	test("automatically triggers /compact when token threshold is reached and suppresses maintenance output", async () => {
		const root = await mkdtemp(join(tmpdir(), "agy-compaction-test-"));
		const projectRoot = join(import.meta.dir, "..");
		const fake = join(root, "fake-agy");
		const promptLog = join(root, "prompts.log");

		const profileSlug = "acct-test";
		const profileDir = join(root, "profiles", profileSlug);
		await mkdir(profileDir, { recursive: true });
		await writeFile(join(profileDir, "profile.json"), JSON.stringify({ slug: profileSlug, createdAt: new Date().toISOString() }));

		await writeFile(fake, createFakeAgyScript());
		await chmod(fake, 0o755);

		// Threshold set to 50,000; simulation emits 60,000 tokens
		const proxy = Bun.spawn(
			["bun", "run", join(projectRoot, "src/index.ts"), "acp", "--compaction-threshold", "50000"],
			{
				cwd: projectRoot,
				env: {
					...process.env,
					AGY_MULTI_ROOT: root,
					AGY_BIN: fake,
					FAKE_AGY_PROMPT_LOG: promptLog,
					FAKE_AGY_TOKENS: "60000",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);

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

			const clientReceivedChunks: string[] = [];
			new LineReader(proxy.stdout, line => {
				let message: unknown;
				try { message = JSON.parse(line); } catch { return; }
				if (isRecord(message) && typeof message.id === "number" && pending.has(message.id)) {
					const resolve = pending.get(message.id)!;
					pending.delete(message.id);
					resolve(message);
					return;
				}
				if (isRecord(message) && message.method === "session/update" && isRecord(message.params)) {
					const update = message.params.update;
					if (isRecord(update) && update.sessionUpdate === "agent_message_chunk" && isRecord(update.content)) {
						if (typeof update.content.text === "string") {
							clientReceivedChunks.push(update.content.text);
						}
					}
				}
			});

			await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
			const created = await send<{ result: { sessionId: string } }>("session/new", {
				cwd: root,
				mcpServers: [],
			});
			const sessionId = created.result.sessionId;

			const reply = await send<{ result: { stopReason: string } }>("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "Do some work" }],
			});

			expect(reply.result.stopReason).toBe("end_turn");

			// Check prompts received by backend
			const prompts = (await readFile(promptLog, "utf8")).trim().split("\n");
			expect(prompts).toEqual(["Do some work", "/compact"]);

			// Crucial check: client MUST receive "Normal response" but NEVER "Compacted history summary"
			expect(clientReceivedChunks).toContain("Normal response");
			expect(clientReceivedChunks).not.toContain("Compacted history summary");
		} finally {
			proxy.kill();
			await proxy.exited.catch(() => {});
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);

	test("does NOT trigger /compact when token threshold is not reached", async () => {
		const root = await mkdtemp(join(tmpdir(), "agy-compaction-low-"));
		const projectRoot = join(import.meta.dir, "..");
		const fake = join(root, "fake-agy");
		const promptLog = join(root, "prompts.log");

		const profileSlug = "acct-test";
		const profileDir = join(root, "profiles", profileSlug);
		await mkdir(profileDir, { recursive: true });
		await writeFile(join(profileDir, "profile.json"), JSON.stringify({ slug: profileSlug, createdAt: new Date().toISOString() }));

		await writeFile(fake, createFakeAgyScript());
		await chmod(fake, 0o755);

		// Threshold 50,000; simulation emits 10,000 tokens
		const proxy = Bun.spawn(
			["bun", "run", join(projectRoot, "src/index.ts"), "acp", "--compaction-threshold", "50000"],
			{
				cwd: projectRoot,
				env: {
					...process.env,
					AGY_MULTI_ROOT: root,
					AGY_BIN: fake,
					FAKE_AGY_PROMPT_LOG: promptLog,
					FAKE_AGY_TOKENS: "10000",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);

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
				try { message = JSON.parse(line); } catch { return; }
				if (isRecord(message) && typeof message.id === "number" && pending.has(message.id)) {
					const resolve = pending.get(message.id)!;
					pending.delete(message.id);
					resolve(message);
				}
			});

			await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
			const created = await send<{ result: { sessionId: string } }>("session/new", { cwd: root });
			const reply = await send<{ result: { stopReason: string } }>("session/prompt", {
				sessionId: created.result.sessionId,
				prompt: [{ type: "text", text: "Low token task" }],
			});

			expect(reply.result.stopReason).toBe("end_turn");
			const prompts = (await readFile(promptLog, "utf8")).trim().split("\n");
			expect(prompts).toEqual(["Low token task"]);
		} finally {
			proxy.kill();
			await proxy.exited.catch(() => {});
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);

	test("does NOT trigger /compact when compaction threshold is set to 0 (disabled)", async () => {
		const root = await mkdtemp(join(tmpdir(), "agy-compaction-disabled-"));
		const projectRoot = join(import.meta.dir, "..");
		const fake = join(root, "fake-agy");
		const promptLog = join(root, "prompts.log");

		const profileSlug = "acct-test";
		const profileDir = join(root, "profiles", profileSlug);
		await mkdir(profileDir, { recursive: true });
		await writeFile(join(profileDir, "profile.json"), JSON.stringify({ slug: profileSlug, createdAt: new Date().toISOString() }));

		await writeFile(fake, createFakeAgyScript());
		await chmod(fake, 0o755);

		// Threshold 0 (disabled); tokens 60,000
		const proxy = Bun.spawn(
			["bun", "run", join(projectRoot, "src/index.ts"), "acp", "--compaction-threshold", "0"],
			{
				cwd: projectRoot,
				env: {
					...process.env,
					AGY_MULTI_ROOT: root,
					AGY_BIN: fake,
					FAKE_AGY_PROMPT_LOG: promptLog,
					FAKE_AGY_TOKENS: "60000",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);

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
				try { message = JSON.parse(line); } catch { return; }
				if (isRecord(message) && typeof message.id === "number" && pending.has(message.id)) {
					const resolve = pending.get(message.id)!;
					pending.delete(message.id);
					resolve(message);
				}
			});

			await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
			const created = await send<{ result: { sessionId: string } }>("session/new", { cwd: root });
			const reply = await send<{ result: { stopReason: string } }>("session/prompt", {
				sessionId: created.result.sessionId,
				prompt: [{ type: "text", text: "Disabled threshold test" }],
			});

			expect(reply.result.stopReason).toBe("end_turn");
			const prompts = (await readFile(promptLog, "utf8")).trim().split("\n");
			expect(prompts).toEqual(["Disabled threshold test"]);
		} finally {
			proxy.kill();
			await proxy.exited.catch(() => {});
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);

	test("auto-compaction failure does not fail the user prompt", async () => {
		const root = await mkdtemp(join(tmpdir(), "agy-compaction-fail-"));
		const projectRoot = join(import.meta.dir, "..");
		const fake = join(root, "fake-agy");
		const promptLog = join(root, "prompts.log");

		const profileSlug = "acct-test";
		const profileDir = join(root, "profiles", profileSlug);
		await mkdir(profileDir, { recursive: true });
		await writeFile(join(profileDir, "profile.json"), JSON.stringify({ slug: profileSlug, createdAt: new Date().toISOString() }));

		// Fake agy fails when /compact is requested
		await writeFile(fake, createFakeAgyScript({ failCompact: true }));
		await chmod(fake, 0o755);

		const proxy = Bun.spawn(
			["bun", "run", join(projectRoot, "src/index.ts"), "acp", "--compaction-threshold", "50000"],
			{
				cwd: projectRoot,
				env: {
					...process.env,
					AGY_MULTI_ROOT: root,
					AGY_BIN: fake,
					FAKE_AGY_PROMPT_LOG: promptLog,
					FAKE_AGY_TOKENS: "60000",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);

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
				try { message = JSON.parse(line); } catch { return; }
				if (isRecord(message) && typeof message.id === "number" && pending.has(message.id)) {
					const resolve = pending.get(message.id)!;
					pending.delete(message.id);
					resolve(message);
				}
			});

			await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
			const created = await send<{ result: { sessionId: string } }>("session/new", { cwd: root });
			const reply = await send<{ result: { stopReason: string } }>("session/prompt", {
				sessionId: created.result.sessionId,
				prompt: [{ type: "text", text: "Turn that should succeed" }],
			});

			// User turn STILL succeeds even though /compact errored!
			expect(reply.result.stopReason).toBe("end_turn");
			const prompts = (await readFile(promptLog, "utf8")).trim().split("\n");
			expect(prompts).toEqual(["Turn that should succeed", "/compact"]);
		} finally {
			proxy.kill();
			await proxy.exited.catch(() => {});
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});
