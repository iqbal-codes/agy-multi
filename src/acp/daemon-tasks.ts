import { isRecord } from "./guards";

/**
 * Antigravity runs long commands as daemon tasks (`<conversation>/task-N`).
 * ACP is turn-based: those tasks keep running after `session/prompt` resolves
 * and nothing wakes the agent again once the turn is closed. The proxy reads
 * the task references out of the mirrored tool calls so it can hold the turn
 * open instead of reporting a turn that ended while work was still running.
 */

/** Poll interval when the runtime gave no timer; matches the native `schedule` floor. */
const DEFAULT_POLL_MS = 15_000;
/** Never sleep longer than this between continuation prompts. */
const MAX_WAIT_MS = 60_000;

export const DAEMON_HOLD_MAX_CONTINUATIONS = 120;
export const DAEMON_HOLD_MAX_MS = 60 * 60 * 1000;

export interface DaemonTaskSignal {
	readonly taskId: string;
	/** Wall-clock millis at which the runtime's own timer fires. */
	readonly waitUntil?: number;
	/** The call terminates the task instead of observing it. */
	readonly terminal: boolean;
}

const TERMINAL_ACTIONS = new Set(["kill", "stop", "cancel"]);

function readString(value: unknown): string | undefined {
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

	const action = readString(input.Action)?.toLowerCase();
	const taskId = readString(input.TaskId) ?? readString(input.TimerCondition);
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
 *
 * Only an explicit runtime timer arms a hold: the agent arms one when it means
 * to wait for the task. A bare `manage_task status` also happens *after* a task
 * finished, so it must not arm a new hold — it only refreshes a wait already
 * armed, which is what keeps a finished task from holding the turn forever.
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

/**
 * Sleep until the next runtime timer, capped so a missed wake-up cannot stall
 * the turn. Tracked tasks without a timer fall back to the default poll.
 */
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
		"Call `manage_task` with Action \"status\" for each id and keep working:",
		"- if a task finished, report its result and continue the task;",
		"- if it is still running, keep waiting (short `schedule` timers) until it finishes;",
		"- if you deliberately abandon it, terminate it with Action \"kill\" and say so.",
		"Do not end the turn while any of these tasks is still running.",
	].join("\n");
}
