import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { SessionState } from "../src/acp/session-ledger";
import {
	applyDaemonSignal,
	DAEMON_HOLD_MAX_MS,
	daemonHoldPrompt,
	daemonTaskSignal,
	DEFAULT_COMPACTION_THRESHOLD,
	DEFAULT_MODEL_CONTEXT_WINDOW,
	nextWaitMs,
	readLatestTokenUsage,
	resolveCompactionThreshold,
	resolveModelContextWindow,
	resolveSessionTokenUsage,
	TurnSupervisor,
	type TurnTransport,
} from "../src/acp/turn-supervisor";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
	const record = {
		id: "proxy-1",
		profile: "acct-a",
		childSessionId: "child-1",
		cwd: "/tmp",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
	return {
		...record,
		mcpServers: [],
		history: [],
		record,
		...overrides,
	};
}

describe("daemon task signals & transcript token helpers", () => {
	test("parses schedule timers, status polls, and terminal kill/stop/cancel actions", () => {
		const map = new Map<string, { waitUntil?: number }>();
		applyDaemonSignal(map, daemonTaskSignal({ rawInput: { Action: "status", TaskId: "conv/t1" } }, 0));
		expect(map.size).toBe(0); // bare status never arms a hold

		applyDaemonSignal(map, daemonTaskSignal({ rawInput: { DurationSeconds: 10, TimerCondition: "conv/t1" } }, 1_000));
		expect(map.get("conv/t1")?.waitUntil).toBe(11_000);

		applyDaemonSignal(map, daemonTaskSignal({ rawInput: { Action: "status", TaskId: "conv/t1" } }, 5_000));
		expect(map.get("conv/t1")?.waitUntil).toBe(11_000);

		applyDaemonSignal(map, daemonTaskSignal({ rawInput: { Action: "kill", TaskId: "conv/t1" } }, 6_000));
		expect(map.size).toBe(0);

		expect(nextWaitMs([9_000, 3_000], 1_000)).toBe(2_000);
		expect(nextWaitMs([], 1_000)).toBe(15_000);
		expect(nextWaitMs([10 * 60_000], 0)).toBe(60_000);
		expect(DAEMON_HOLD_MAX_MS).toBeLessThanOrEqual(60 * 60 * 1000);
		expect(daemonHoldPrompt(["conv/t1"])).toContain("Do not end the turn");
	});

	test("reads latest complete token row from large and compacted transcripts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agy-turn-transcript-"));
		try {
			const logs = join(dir, ".gemini", "antigravity-cli", "brain", "s1", ".system_generated", "logs");
			await mkdir(logs, { recursive: true });
			const file = join(logs, "transcript.jsonl");
			await writeFile(
				file,
				[
					JSON.stringify({ input_tokens: 5000, cache_read_tokens: 250000, output_tokens: 1000 }),
					JSON.stringify({ type: "CHECKPOINT" }),
					JSON.stringify({ input_tokens: 2000, cache_read_tokens: 3000, output_tokens: 100, content: "文".repeat(70_000) }),
					'{"input_tokens":',
				].join("\n"),
			);
			expect(readLatestTokenUsage(file)?.usedTokens).toBe(5100);
			expect(resolveSessionTokenUsage(dir, "s1")?.usedTokens).toBe(5100);
			expect(resolveSessionTokenUsage(dir, "missing")).toBeNull();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("resolves compaction threshold precedence and model context windows", async () => {
		expect(DEFAULT_COMPACTION_THRESHOLD).toBe(300_000);
		expect(DEFAULT_MODEL_CONTEXT_WINDOW).toBe(1_048_576);
		expect(resolveCompactionThreshold(50_000, { AGY_COMPACTION_THRESHOLD: "200000" }, "")).toBe(50_000);
		expect(resolveCompactionThreshold(undefined, { AGY_COMPACTION_THRESHOLD: "200000" }, "")).toBe(200_000);
		expect(resolveModelContextWindow("gemini-2.5-pro")).toBe(2_097_152);
		expect(resolveModelContextWindow("claude-3-7-sonnet")).toBe(200_000);
		expect(resolveModelContextWindow("gpt-4o")).toBe(128_000);
	});
});

describe("TurnSupervisor via in-memory TurnTransport adapter", () => {
	test("holds turns across daemon continuations and enforces max continuation cap in milliseconds", async () => {
		let clock = 1_000;
		const supervisor = new TurnSupervisor({
			maxHoldContinuations: 3,
			now: () => clock,
			sleep: async ms => {
				clock += ms;
			},
		});
		const session = makeSession();
		const prompts: string[] = [];
		const emitted: unknown[] = [];

		const transport: TurnTransport = {
			emit: msg => emitted.push(msg),
			request: async (_method, params) => {
				const text = (params as { prompt: Array<{ text: string }> }).prompt[0]!.text;
				prompts.push(text);
				// Every turn re-arms a 5s timer on conv/task-1 without finishing it.
				supervisor.handleTurnUpdate({
					session,
					kind: "tool_call",
					update: { rawInput: { DurationSeconds: 5, TimerCondition: "conv/task-1" } },
					outMessage: { kind: "tool_call" },
					deliver: msg => emitted.push(msg),
					emit: msg => emitted.push(msg),
				});
				return { jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } };
			},
		};

		const outcome = await supervisor.executePrompt({
			session,
			text: "run long build",
			suppressUserChunk: false,
			transport,
		});

		expect(outcome.status).toBe("hold_exhausted");
		if (outcome.status === "hold_exhausted") {
			expect(outcome.taskIds).toEqual(["conv/task-1"]);
			expect(outcome.continuations).toBe(3);
		}
		expect(prompts).toHaveLength(4); // 1 initial + 3 hold continuations
		expect(session.activeTurn).toBeUndefined();
	});

	test("cancel during daemon hold exits immediately without sending another prompt", async () => {
		let clock = 0;
		const session = makeSession();
		const supervisor = new TurnSupervisor({
			now: () => clock,
			sleep: async ms => {
				clock += ms;
				// Cancel during the first wait slice.
				session.cancelled = true;
			},
		});
		let calls = 0;
		const transport: TurnTransport = {
			emit: () => {},
			request: async () => {
				calls += 1;
				supervisor.handleTurnUpdate({
					session,
					kind: "tool_call",
					update: { rawInput: { DurationSeconds: 30, TimerCondition: "conv/task-9" } },
					outMessage: {},
					deliver: () => {},
					emit: () => {},
				});
				return { jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } };
			},
		};

		const outcome = await supervisor.executePrompt({
			session,
			text: "start build",
			suppressUserChunk: false,
			transport,
		});
		expect(outcome.status).toBe("cancelled");
		expect(calls).toBe(1);
	});

	test("auto-compaction suppresses maintenance output and handles timeouts non-fatally", async () => {
		let clock = 0;
		let currentTokens = 350_000;
		const emitted: unknown[] = [];
		const supervisor = new TurnSupervisor({
			compactionThreshold: 300_000,
			compactionTimeoutMs: 50,
			now: () => clock,
			sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
			resolveUsage: () => ({ usedTokens: currentTokens }),
		});
		const session = makeSession({ modelId: "gemini-3.8-flash" });

		// Successful compaction suppresses child chunks and reports true.
		const okTransport: TurnTransport = {
			emit: msg => emitted.push(msg),
			request: async (_method, params) => {
				const text = (params as { prompt: Array<{ text: string }> }).prompt[0]!.text;
				expect(text).toBe("/compact");
				supervisor.handleTurnUpdate({
					session,
					kind: "agent_message_chunk",
					update: { content: { type: "text", text: "Compacted!" } },
					outMessage: { hidden: true },
					deliver: msg => emitted.push(msg),
					emit: msg => emitted.push(msg),
				});
				currentTokens = 12_000;
				return { jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } };
			},
		};
		expect(
			await supervisor.maybeAutoCompact({
				session,
				profileSlug: "acct-a",
				profileHomeDir: "/tmp/home",
				transport: okTransport,
			}),
		).toBe(true);
		expect(emitted).toEqual([]); // output suppressed!

		// Timeout returns false non-fatally and cleans up activeTurn.
		currentTokens = 400_000;
		const hungTransport: TurnTransport = {
			emit: () => {},
			request: () => new Promise(() => {}),
		};
		expect(
			await supervisor.maybeAutoCompact({
				session,
				profileSlug: "acct-a",
				profileHomeDir: "/tmp/home",
				transport: hungTransport,
			}),
		).toBe(false);
		expect(session.activeTurn).toBeUndefined();
	});
});
