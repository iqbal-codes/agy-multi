import { describe, expect, test } from "bun:test";
import { blockingReset, familyForModel, minRemaining, parseUsageTable, windowRemaining, windowReset } from "../src/usage";
import type { UsageSnapshot } from "../src/types";

const TABLE = [
	"Gemini Models\tWeekly Limit Remaining\t99%\t2026-11-15T23:41:21Z",
	"Gemini Models\tFive Hour Limit Remaining\t40%\t2026-11-09T04:41:21Z",
	"Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-15T23:41:21Z",
	"Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-09T04:41:21Z",
].join("\n");

describe("usage parsing", () => {
	test("parses both families and windows", () => {
		const windows = parseUsageTable(TABLE);
		expect(windows).toHaveLength(4);
		expect(windows[0]).toEqual({
			family: "gemini",
			window: "weekly",
			remainingPct: 99,
			resetsAt: "2026-11-15T23:41:21Z",
		});
	});

	test("binding window is the minimum", () => {
		const snapshot = snapshotOf(TABLE);
		expect(minRemaining(snapshot, "gemini")).toBe(40);
		expect(minRemaining(snapshot, "claude-gpt")).toBe(100);
	});

	test("windowRemaining and windowReset extract specific window values", () => {
		const snapshot = snapshotOf(TABLE);
		expect(windowRemaining(snapshot, "gemini", "weekly")).toBe(99);
		expect(windowRemaining(snapshot, "gemini", "fiveHour")).toBe(40);
		expect(windowReset(snapshot, "gemini", "weekly")).toBe(Date.parse("2026-11-15T23:41:21Z"));
		expect(windowReset(snapshot, "gemini", "fiveHour")).toBe(Date.parse("2026-11-09T04:41:21Z"));
	});

	test("blocking reset prefers an exhausted window", () => {
		const table = [
			"Gemini Models\tWeekly Limit Remaining\t90%\t2026-11-15T23:41:21Z",
			"Gemini Models\tFive Hour Limit Remaining\t0%\t2026-11-09T04:41:21Z",
		].join("\n");
		const snapshot = snapshotOf(table);
		expect(blockingReset(snapshot, "gemini", Date.parse("2026-11-09T00:00:00Z"))).toBe(
			Date.parse("2026-11-09T04:41:21Z"),
		);
	});

	test("families map from model ids", () => {
		expect(familyForModel("gemini-3.8-flash")).toBe("gemini");
		expect(familyForModel("claude-sonnet-4.5")).toBe("claude-gpt");
		expect(familyForModel("gpt-5.1")).toBe("claude-gpt");
		expect(familyForModel(undefined)).toBe("gemini");
	});
});

function snapshotOf(table: string): UsageSnapshot {
	return { profile: "test", fetchedAt: 0, windows: parseUsageTable(table), raw: table };
}
