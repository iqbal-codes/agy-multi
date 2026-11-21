import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../fs-utils";
import type { JsonRpcErrorObject, JsonRpcResponse } from "./rpc";
import type { SessionState, TurnState } from "./session-ledger";

/** Poll interval when the runtime gave no timer; matches the native `schedule` floor. */
const DEFAULT_POLL_MS = 15_000;
/** Never sleep longer than this between continuation prompts. */
const MAX_WAIT_MS = 60_000;
/** Poll slice while sleeping during a daemon hold so `session/cancel` responds promptly. */
const CANCEL_POLL_SLICE_MS = 250;

export const DAEMON_HOLD_MAX_CONTINUATIONS = 120;
export const DAEMON_HOLD_MAX_MS = 60 * 60 * 1000;
export const DEFAULT_COMPACTION_THRESHOLD = 300_000;
export const DEFAULT_MODEL_CONTEXT_WINDOW = 1_048_576;
export const COMPACTION_TIMEOUT_MS = 30_000;

export interface DaemonTaskSignal {
	readonly taskId: string;
	/** Wall-clock millis at which the runtime's own timer fires. */
	readonly waitUntil?: number;
	/** The call terminates the task instead of observing it. */
	readonly terminal: boolean;
}

export interface TokenUsageResult {
	usedTokens: number;
	inputTokens?: number;
	cacheReadTokens?: number;
	outputTokens?: number;
}

const TERMINAL_ACTIONS = new Set(["kill", "stop", "cancel"]);

function readTrimmedString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Mirrored `manage_task` / `schedule` calls carry the daemon task reference in
 * `rawInput`: `{ Action, TaskId }` and `{ DurationSeconds, TimerCondition }`.
 */
export function daemonTaskSignal(update: unknown, now: number): DaemonTaskSignal | undefined {
	if (!isRecord(update)) return undefined;
	const input = isRecord(update.rawInput) ? update.rawInput : undefined;
	if (!input) return undefined;

	const action = readTrimmedString(input.Action)?.toLowerCase();
	const taskId = readTrimmedString(input.TaskId) ?? readTrimmedString(input.TimerCondition);
	if (!taskId) return undefined;

	const seconds = typeof input.DurationSeconds === "number" ? input.DurationSeconds : undefined;
	const waitUntil =
		seconds !== undefined && seconds > 0 ? now + Math.min(seconds * 1000, MAX_WAIT_MS) : undefined;

	return {
		taskId,
		...(waitUntil !== undefined ? { waitUntil } : {}),
		terminal: action !== undefined && TERMINAL_ACTIONS.has(action),
	};
}

/**
 * Applies one mirrored tool call to the turn's daemon tasks.
 * Only an explicit runtime timer arms a hold; a bare `manage_task status` only
 * refreshes an already-armed hold so a finished task cannot hold forever.
 */
export function applyDaemonSignal(
	tasks: Map<string, { waitUntil?: number }>,
	signal: DaemonTaskSignal | undefined,
): void {
	if (!signal) return;
	if (signal.terminal) {
		tasks.delete(signal.taskId);
		return;
	}
	const waitUntil = signal.waitUntil ?? tasks.get(signal.taskId)?.waitUntil;
	if (waitUntil !== undefined) tasks.set(signal.taskId, { waitUntil });
}

/** Sleep until the soonest runtime timer, bounded by `MAX_WAIT_MS`. */
export function nextWaitMs(taskWaits: Iterable<number>, now: number): number {
	let soonest: number | undefined;
	for (const until of taskWaits) {
		const remaining = Math.max(0, until - now);
		if (soonest === undefined || remaining < soonest) soonest = remaining;
	}
	return Math.min(soonest ?? DEFAULT_POLL_MS, MAX_WAIT_MS);
}

/** Sent to the child when its turn ended while a daemon task was still running. */
export function daemonHoldPrompt(taskIds: ReadonlyArray<string>): string {
	return [
		`Your last turn ended while these background tasks were still running: ${taskIds.join(", ")}.`,
		"ACP is turn-based: once the turn closes nothing wakes you, so a pending task is never resumed.",
		'Call `manage_task` with Action "status" for each id and keep working:',
		"- if a task finished, report its result and continue the task;",
		"- if it is still running, keep waiting (short `schedule` timers) until it finishes;",
		'- if you deliberately abandon it, terminate it with Action "kill" and say so.',
		"Do not end the turn while any of these tasks is still running.",
	].join("\n");
}

/** Resolves model context window capacity (in tokens) based on model identifier. */
export function resolveModelContextWindow(modelId?: string): number {
	if (!modelId) return DEFAULT_MODEL_CONTEXT_WINDOW;
	const id = modelId.toLowerCase();
	if (id.includes("pro")) return 2_097_152;
	if (id.includes("claude")) return 200_000;
	if (id.includes("gpt") || id.includes("o1") || id.includes("o3")) return 128_000;
	return DEFAULT_MODEL_CONTEXT_WINDOW;
}

/**
 * Reads the latest token usage numbers from a session transcript file.
 * Scans backwards in 64KiB blocks, carrying incomplete lines across blocks.
 */
export function readLatestTokenUsage(filePath: string): TokenUsageResult | null {
	try {
		if (!existsSync(filePath)) return null;
		const stat = statSync(filePath);
		if (stat.size === 0) return null;

		const fd = openSync(filePath, "r");
		try {
			let position = stat.size;
			let carry = Buffer.alloc(0);
			while (position > 0) {
				const size = Math.min(position, 65536);
				position -= size;
				const block = Buffer.alloc(size);
				const count = readSync(fd, block, 0, size, position);
				const data = Buffer.concat([block.subarray(0, count), carry]);
				let end = data.length;
				for (let index = data.length - 1; index >= -1; index--) {
					if (index >= 0 && data[index] !== 10) continue;
					if (index === -1 && position > 0) break;
					const line = data.subarray(index + 1, end).toString("utf8");
					end = index;
					if (!line.trim()) continue;
					let item;
					try {
						item = JSON.parse(line);
					} catch {
						continue;
					}
					if (!item || !Number.isFinite(item.input_tokens) || item.input_tokens < 0) continue;
					const inputTokens = item.input_tokens;
					const cacheReadTokens =
						Number.isFinite(item.cache_read_tokens) && item.cache_read_tokens >= 0 ? item.cache_read_tokens : 0;
					const outputTokens =
						Number.isFinite(item.output_tokens) && item.output_tokens >= 0 ? item.output_tokens : 0;
					return {
						usedTokens: inputTokens + cacheReadTokens + outputTokens,
						inputTokens,
						cacheReadTokens,
						outputTokens,
					};
				}
				carry = data.subarray(0, Math.max(0, end));
			}
		} finally {
			closeSync(fd);
		}
	} catch {
		// Ignore any fs or parsing errors
	}
	return null;
}

/** Searches common locations where Antigravity stores conversation transcripts. */
export function findSessionTranscript(profileHomeDir: string, childSessionId: string): string | null {
	const candidateHomes = [profileHomeDir];
	if (process.env.HOME && process.env.HOME !== profileHomeDir) {
		candidateHomes.push(process.env.HOME);
	}
	for (const home of candidateHomes) {
		const candidatePaths = [
			join(home, ".gemini", "antigravity-cli", "brain", childSessionId, ".system_generated", "logs", "transcript.jsonl"),
			join(home, ".gemini", "brain", childSessionId, ".system_generated", "logs", "transcript.jsonl"),
			join(home, "brain", childSessionId, ".system_generated", "logs", "transcript.jsonl"),
		];
		for (const path of candidatePaths) {
			if (existsSync(path)) return path;
		}
	}
	return null;
}

/** Transcript usage is unavailable when there is no complete token-bearing row. */
export function resolveSessionTokenUsage(
	profileHomeDir: string | undefined,
	childSessionId: string,
): TokenUsageResult | null {
	if (!profileHomeDir) return null;
	const transcript = findSessionTranscript(profileHomeDir, childSessionId);
	return transcript ? readLatestTokenUsage(transcript) : null;
}

/**
 * Resolves the token threshold for auto-compaction.
 * Precedence: option → env → settings.json → DEFAULT_COMPACTION_THRESHOLD (300,000).
 * Set to 0 to disable auto-compaction.
 */
export function resolveCompactionThreshold(
	optionValue?: number,
	env: Record<string, string | undefined> = process.env,
	homeDir: string = process.env.HOME ?? "",
): number {
	if (typeof optionValue === "number" && Number.isFinite(optionValue) && optionValue >= 0) {
		return optionValue;
	}
	const envVal = env.AGY_COMPACTION_THRESHOLD ?? env.AGY_MULTI_COMPACTION_THRESHOLD;
	if (envVal !== undefined && envVal.trim() !== "") {
		const parsed = Number.parseInt(envVal.trim(), 10);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	if (homeDir) {
		const candidateSettingsPaths = [
			join(homeDir, ".gemini", "antigravity-cli", "settings.json"),
			join(homeDir, ".gemini", "settings.json"),
		];
		for (const settingsPath of candidateSettingsPaths) {
			try {
				if (existsSync(settingsPath)) {
					const text = readFileSync(settingsPath, "utf8");
					const parsed = JSON.parse(text);
					if (parsed && typeof parsed === "object") {
						const threshold = parsed.compactionThreshold ?? parsed.compaction_threshold;
						if (typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 0) {
							return threshold;
						}
					}
				}
			} catch {
				// Ignore file read or parse error
			}
		}
	}
	return DEFAULT_COMPACTION_THRESHOLD;
}

/**
 * Seam for turn execution: satisfied by `AcpChild` + `LineWriter` in production
 * and an in-memory adapter in tests.
 */
export interface TurnTransport {
	request(method: string, params: unknown): Promise<JsonRpcResponse>;
	emit(message: unknown): void;
}

export interface TurnSupervisorOptions {
	compactionThreshold?: number;
	compactionTimeoutMs?: number;
	maxHoldContinuations?: number;
	maxHoldMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	log?: (line: string) => void;
	resolveUsage?: (profileHomeDir: string | undefined, childSessionId: string) => TokenUsageResult | null;
}

export type TurnOutcome =
	| { status: "ok"; result: unknown; turn: TurnState }
	| { status: "cancelled"; turn: TurnState }
	| { status: "hold_exhausted"; taskIds: string[]; continuations: number; turn: TurnState }
	| { status: "error"; error: JsonRpcErrorObject; turn: TurnState };

/**
 * Deep module supervising an in-flight ACP turn: stream chunk tracking,
 * daemon-hold continuation loops, post-turn auto-compaction, and usage updates.
 */
export class TurnSupervisor {
	readonly compactionThreshold: number;
	private readonly compactionTimeoutMs: number;
	private readonly maxHoldContinuations: number;
	private readonly maxHoldMs: number;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly log: (line: string) => void;
	private readonly resolveUsage: (profileHomeDir: string | undefined, childSessionId: string) => TokenUsageResult | null;

	constructor(options: TurnSupervisorOptions = {}) {
		this.compactionThreshold = resolveCompactionThreshold(options.compactionThreshold);
		this.compactionTimeoutMs = options.compactionTimeoutMs ?? COMPACTION_TIMEOUT_MS;
		this.maxHoldContinuations = options.maxHoldContinuations ?? DAEMON_HOLD_MAX_CONTINUATIONS;
		this.maxHoldMs = options.maxHoldMs ?? DAEMON_HOLD_MAX_MS;
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
		this.log = options.log ?? (() => {});
		this.resolveUsage = options.resolveUsage ?? resolveSessionTokenUsage;
	}

	/**
	 * Process turn-scoped agent update events (`agent_message_chunk`, `agent_thought_chunk`,
	 * `user_message_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`).
	 * Returns `true` when the event was handled here.
	 */
	handleTurnUpdate(options: {
		session: SessionState;
		kind: string | undefined;
		update: Record<string, unknown>;
		outMessage: unknown;
		deliver: (value: unknown) => void;
		profileHomeDir?: string;
		emit: (message: unknown) => void;
		onLoadChunk?: (role: "user" | "assistant", text: string) => void;
	}): boolean {
		const { session, kind, update, outMessage, deliver, profileHomeDir, emit, onLoadChunk } = options;
		const content = isRecord(update.content) ? update.content : undefined;
		const text = content && typeof content.text === "string" ? content.text : "";

		if (kind === "agent_message_chunk") {
			if (session.activeTurn) {
				session.activeTurn.assistantText += text;
				if (text) session.activeTurn.forwardedOutput = true;
			} else if (session.loading) {
				onLoadChunk?.("assistant", text);
			}
			if (session.activeTurn?.suppressOutput) return true;
			deliver(outMessage);
			this.maybeBroadcastRealtimeUsage(session, profileHomeDir, emit);
			return true;
		}
		if (kind === "agent_thought_chunk") {
			if (session.activeTurn) session.activeTurn.forwardedOutput = true;
			if (session.activeTurn?.suppressOutput) return true;
			deliver(outMessage);
			this.maybeBroadcastRealtimeUsage(session, profileHomeDir, emit);
			return true;
		}
		if (kind === "user_message_chunk") {
			if (session.loading) onLoadChunk?.("user", text);
			if (session.activeTurn?.suppressUserChunk || session.activeTurn?.suppressOutput) return true;
			deliver(outMessage);
			return true;
		}
		if (kind === "tool_call" || kind === "tool_call_update") {
			if (session.activeTurn) {
				session.activeTurn.forwardedOutput = true;
				const signal = daemonTaskSignal(update, this.now());
				applyDaemonSignal(session.activeTurn.daemonTasks, signal);
			}
			if (session.activeTurn?.suppressOutput) return true;
			deliver(outMessage);
			this.maybeBroadcastRealtimeUsage(session, profileHomeDir, emit, true);
			return true;
		}
		if (kind === "plan") {
			if (session.activeTurn) session.activeTurn.forwardedOutput = true;
			if (session.activeTurn?.suppressOutput) return true;
			deliver(outMessage);
			this.maybeBroadcastRealtimeUsage(session, profileHomeDir, emit, true);
			return true;
		}
		if (kind === "usage_update") {
			if (session.activeTurn) session.activeTurn.seenUsageUpdate = true;
			deliver(outMessage);
			return true;
		}
		return false;
	}

	maybeBroadcastRealtimeUsage(
		session: SessionState,
		profileHomeDir: string | undefined,
		emit: (message: unknown) => void,
		immediate = false,
	): void {
		if (session.loading || session.activeTurn?.suppressOutput || session.activeTurn?.seenUsageUpdate) return;
		const now = this.now();
		if (!immediate && now - (session.lastBroadcastCheckAt ?? 0) < 500) return;
		session.lastBroadcastCheckAt = now;
		this.broadcastUsageUpdate(session, profileHomeDir, emit);
	}

	broadcastUsageUpdate(
		session: SessionState,
		profileHomeDir: string | undefined,
		emit: (message: unknown) => void,
	): void {
		if (!profileHomeDir) return;
		const usage = this.resolveUsage(profileHomeDir, session.childSessionId);
		if (!usage) return;
		if (usage.usedTokens === session.lastBroadcastedUsedTokens) return;
		session.lastBroadcastedUsedTokens = usage.usedTokens;
		const maxTokens = resolveModelContextWindow(session.modelId);
		emit({
			jsonrpc: "2.0",
			method: "session/update",
			params: {
				sessionId: session.id,
				update: {
					sessionUpdate: "usage_update",
					used: usage.usedTokens,
					size: maxTokens,
				},
			},
		});
	}

	/**
	 * Send `session/prompt` and hold the turn open across any running daemon tasks
	 * until they complete, the user cancels, or the continuation/time caps are reached.
	 */
	async executePrompt(options: {
		session: SessionState;
		text: string;
		suppressUserChunk: boolean;
		transport: TurnTransport;
		beforePrompt?: () => Promise<void>;
	}): Promise<TurnOutcome> {
		const { session, text, suppressUserChunk, transport, beforePrompt } = options;
		const turn: TurnState = {
			assistantText: "",
			forwardedOutput: false,
			suppressUserChunk,
			daemonTasks: new Map(),
		};
		session.cancelled = false;
		session.activeTurn = turn;
		try {
			if (beforePrompt) await beforePrompt();
			let response = await transport.request("session/prompt", {
				sessionId: session.childSessionId,
				prompt: [{ type: "text", text }],
			});

			const holdStartedAt = this.now();
			let continuations = 0;
			while (!response.error && !session.cancelled && turn.daemonTasks.size > 0) {
				const taskIds = [...turn.daemonTasks.keys()];
				if (continuations >= this.maxHoldContinuations || this.now() - holdStartedAt >= this.maxHoldMs) {
					this.log(
						`daemon tasks still running after ${continuations} continuation(s): ${taskIds.join(", ")}`,
					);
					return { status: "hold_exhausted", taskIds, continuations, turn };
				}

				const waitMs = nextWaitMs(
					[...turn.daemonTasks.values()].flatMap(task =>
						task.waitUntil === undefined ? [] : [task.waitUntil],
					),
					this.now(),
				);
				this.log(
					`turn ended with ${taskIds.length} background task(s) still running (${taskIds.join(", ")}); holding ${waitMs}ms before resuming`,
				);
				await this.waitForDaemon(waitMs, session);
				if (session.cancelled) break;

				continuations += 1;
				turn.daemonTasks.clear();
				turn.suppressUserChunk = true;
				response = await transport.request("session/prompt", {
					sessionId: session.childSessionId,
					prompt: [{ type: "text", text: daemonHoldPrompt(taskIds) }],
				});
			}

			if (session.cancelled && !response.error) {
				return { status: "cancelled", turn };
			}
			if (response.error) {
				return { status: "error", error: response.error, turn };
			}
			return { status: "ok", result: response.result, turn };
		} finally {
			if (session.activeTurn === turn) session.activeTurn = undefined;
		}
	}

	/**
	 * Automatically runs `/compact` with suppressed output when measured transcript
	 * token usage reaches `compactionThreshold`. Non-fatal on failure or timeout.
	 */
	async maybeAutoCompact(options: {
		session: SessionState;
		profileSlug: string;
		profileHomeDir: string;
		transport: TurnTransport;
	}): Promise<boolean> {
		const { session, profileSlug, profileHomeDir, transport } = options;
		if (this.compactionThreshold <= 0 || session.cancelled) return false;
		const usage = this.resolveUsage(profileHomeDir, session.childSessionId);
		if (!usage || usage.usedTokens < this.compactionThreshold) return false;

		this.log(
			`token usage (${usage.usedTokens}) reached threshold (${this.compactionThreshold}) on ${profileSlug} session=${session.id}; triggering auto-compaction`,
		);

		const compactionTurn: TurnState = {
			assistantText: "",
			forwardedOutput: false,
			suppressUserChunk: true,
			suppressOutput: true,
			daemonTasks: new Map(),
		};
		session.activeTurn = compactionTurn;
		try {
			const compactPromise = transport.request("session/prompt", {
				sessionId: session.childSessionId,
				prompt: [{ type: "text", text: "/compact" }],
			});
			const timeoutPromise = this.sleep(this.compactionTimeoutMs).then(() => {
				throw new Error(`auto-compaction timed out after ${Math.round(this.compactionTimeoutMs / 1000)}s`);
			});
			const compactResponse = await Promise.race([compactPromise, timeoutPromise]);
			if (compactResponse.error) {
				this.log(
					`auto-compaction prompt failed on ${profileSlug} session=${session.id}: ${compactResponse.error.message}`,
				);
				return false;
			}
			const afterUsage = this.resolveUsage(profileHomeDir, session.childSessionId);
			this.log(
				`auto-compaction completed on ${profileSlug} session=${session.id}: ${usage.usedTokens} -> ${afterUsage?.usedTokens ?? "unknown"} tokens`,
			);
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log(`auto-compaction error on ${profileSlug} session=${session.id}: ${message}`);
			return false;
		} finally {
			if (session.activeTurn === compactionTurn) session.activeTurn = undefined;
		}
	}

	private async waitForDaemon(ms: number, session: SessionState): Promise<void> {
		const deadline = this.now() + Math.max(0, ms);
		while (!session.cancelled && this.now() < deadline) {
			await this.sleep(Math.min(CANCEL_POLL_SLICE_MS, Math.max(0, deadline - this.now())));
		}
	}
}
