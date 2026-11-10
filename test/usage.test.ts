import { describe, expect, test } from "bun:test";
import { blockingReset, familyForModel, minRemaining, parseUsageTable, profileUsagePath, readCachedUsage, windowRemaining, windowReset, writeCachedUsage } from "../src/usage";
import type { UsageSnapshot } from "../src/types";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

	test("persists and loads cached usage snapshots to disk atomically", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "agy-multi-usage-"));
		const prevRoot = process.env.AGY_MULTI_ROOT;
		process.env.AGY_MULTI_ROOT = tempRoot;
		try {
			const initial = await readCachedUsage("test-profile");
			expect(initial).toBeNull();

			const snapshot: UsageSnapshot = {
				profile: "test-profile",
				fetchedAt: Date.now(),
				windows: parseUsageTable(TABLE),
				raw: TABLE,
			};
			await writeCachedUsage(snapshot);

			const loaded = await readCachedUsage("test-profile");
			expect(loaded).not.toBeNull();
			expect(loaded?.profile).toBe("test-profile");
			expect(loaded?.windows).toHaveLength(4);
			expect(loaded?.windows[0]?.remainingPct).toBe(99);
		} finally {
			if (prevRoot !== undefined) process.env.AGY_MULTI_ROOT = prevRoot;
			else delete process.env.AGY_MULTI_ROOT;
			await rm(tempRoot, { recursive: true, force: true });
		}
	});
});

function snapshotOf(table: string): UsageSnapshot {
	return { profile: "test", fetchedAt: 0, windows: parseUsageTable(table), raw: table };
}
