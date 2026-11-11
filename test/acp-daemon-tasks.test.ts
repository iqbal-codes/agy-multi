import { describe, expect, test } from "bun:test";
import {
	DAEMON_HOLD_MAX_MS,
	applyDaemonSignal,
	daemonHoldPrompt,
	daemonTaskSignal,
	nextWaitMs,
} from "../src/acp/daemon-tasks";

describe("daemonTaskSignal", () => {
	test("reads the daemon task from a mirrored manage_task call", () => {
		const signal = daemonTaskSignal(
			{ rawInput: { Action: "status", TaskId: "conv/task-817" } },
			1_000,
		);
		expect(signal).toEqual({ taskId: "conv/task-817", terminal: false });
	});

	test("reads the timer condition from a schedule call", () => {
		const signal = daemonTaskSignal(
			{ rawInput: { DurationSeconds: 30, TimerCondition: "conv/task-817" } },
			1_000,
		);
		expect(signal?.taskId).toBe("conv/task-817");
		expect(signal?.waitUntil).toBe(31_000);
		expect(signal?.terminal).toBe(false);
	});

	test("treats kill/stop/cancel as releasing the task", () => {
		for (const Action of ["kill", "stop", "cancel", "KILL"]) {
			const signal = daemonTaskSignal({ rawInput: { Action, TaskId: "conv/task-1" } }, 0);
			expect(signal?.terminal).toBe(true);
		}
	});

	test("ignores unrelated tool calls", () => {
		expect(daemonTaskSignal({ rawInput: { CommandLine: "cargo xtask ci" } }, 0)).toBeUndefined();
		expect(daemonTaskSignal({ rawInput: { Path: "/tmp/a.rs" } }, 0)).toBeUndefined();
		expect(daemonTaskSignal({}, 0)).toBeUndefined();
		expect(daemonTaskSignal(null, 0)).toBeUndefined();
		expect(daemonTaskSignal({ rawInput: { Action: "status" } }, 0)).toBeUndefined();
	});
});

describe("nextWaitMs", () => {
	test("sleeps until the runtime's own timer", () => {
		expect(nextWaitMs([5_000], 1_000)).toBe(4_000);
	});

	test("picks the soonest of several timers", () => {
		expect(nextWaitMs([9_000, 3_000, 7_000], 1_000)).toBe(2_000);
	});

	test("falls back to a poll interval when no timer is known", () => {
		expect(nextWaitMs([], 1_000)).toBe(15_000);
	});

	test("caps the wait and never returns a negative delay", () => {
		expect(nextWaitMs([10 * 60_000], 0)).toBe(60_000);
		expect(nextWaitMs([500], 10_000)).toBe(0);
	});

	test("keeps the hold bounded well below the continuation cap", () => {
		expect(DAEMON_HOLD_MAX_MS).toBeLessThanOrEqual(60 * 60 * 1000);
	});
});

describe("daemonHoldPrompt", () => {
	test("names every running task and forbids closing the turn", () => {
		const prompt = daemonHoldPrompt(["conv/task-817", "conv/task-795"]);
		expect(prompt).toContain("conv/task-817");
		expect(prompt).toContain("conv/task-795");
		expect(prompt).toContain("manage_task");
		expect(prompt).toContain("Do not end the turn");
	});
});

describe("applyDaemonSignal", () => {
	const tasks = () => new Map<string, { waitUntil?: number }>();

	test("a schedule timer arms the hold", () => {
		const map = tasks();
		applyDaemonSignal(map, daemonTaskSignal({ rawInput: { DurationSeconds: 10, TimerCondition: "conv/t1" } }, 0));
		expect(map.size).toBe(1);
		expect(map.get("conv/t1")?.waitUntil).toBe(10_000);
	});

	test("a bare status poll does not arm a hold on its own", () => {
		// Otherwise a poll after the task finished would hold the turn forever.
		const map = tasks();
		applyDaemonSignal(map, daemonTaskSignal({ rawInput: { Action: "status", TaskId: "conv/t1" } }, 0));
		expect(map.size).toBe(0);
	});

	test("a status poll refreshes an already armed wait", () => {
		const map = tasks();
		applyDaemonSignal(map, daemonTaskSignal({ rawInput: { DurationSeconds: 10, TimerCondition: "conv/t1" } }, 0));
		applyDaemonSignal(map, daemonTaskSignal({ rawInput: { Action: "status", TaskId: "conv/t1" } }, 5_000));
		expect(map.get("conv/t1")?.waitUntil).toBe(10_000);
	});

	test("kill releases the task", () => {
		const map = tasks();
		applyDaemonSignal(map, daemonTaskSignal({ rawInput: { DurationSeconds: 10, TimerCondition: "conv/t1" } }, 0));
		applyDaemonSignal(map, daemonTaskSignal({ rawInput: { Action: "kill", TaskId: "conv/t1" } }, 1_000));
		expect(map.size).toBe(0);
	});

	test("ignores calls that reference no daemon task", () => {
		const map = tasks();
		applyDaemonSignal(map, daemonTaskSignal({ rawInput: { Path: "/tmp/a.rs" } }, 0));
		applyDaemonSignal(map, undefined);
		expect(map.size).toBe(0);
	});
});
