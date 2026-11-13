import { describe, expect, test } from "bun:test";
import { rankProfiles } from "../src/select";
import type { ModelsSnapshot, Profile, UsageSnapshot, WrapperState } from "../src/types";

const profiles: Profile[] = [
	{ slug: "a", createdAt: "" },
	{ slug: "b", createdAt: "" },
	{ slug: "c", createdAt: "" },
];

function snapshot(slug: string, pct: number): UsageSnapshot {
	return {
		profile: slug,
		fetchedAt: 0,
		raw: "",
		windows: [{ family: "gemini", window: "fiveHour", remainingPct: pct, resetsAt: "2026-11-09T10:00:00Z" }],
	};
}

function state(): WrapperState {
	return { version: 1, pins: {}, blocks: {}, checkpoints: {} };
}

describe("profile ranking", () => {
	test("more headroom first, unmeasured last", () => {
		const usage = new Map<string, UsageSnapshot | null>([
			["a", snapshot("a", 20)],
			["b", snapshot("b", 80)],
			["c", null],
		]);
		expect(rankProfiles(profiles, usage, state(), { now: 0, reservePct: 10, modelId: "gemini-3.8-flash" })).toEqual([
			"b",
			"a",
			"c",
		]);
	});

	test("blocked profiles are excluded", () => {
		const usage = new Map<string, UsageSnapshot | null>([
			["a", snapshot("a", 20)],
			["b", snapshot("b", 80)],
			["c", null],
		]);
		const blocked = state();
		blocked.blocks.a = { gemini: 1_000 };
		expect(
			rankProfiles(profiles, usage, blocked, { now: 0, reservePct: 10, modelId: "gemini-3.8-flash" }),
		).toEqual(["b", "c"]);
	});

	test("disabled profiles are excluded", () => {
		const usage = new Map<string, UsageSnapshot | null>([
			["a", snapshot("a", 20)],
			["b", snapshot("b", 80)],
			["c", null],
		]);
		const disabledProfiles: Profile[] = [
			{ slug: "a", createdAt: "", disabled: true },
			{ slug: "b", createdAt: "" },
			{ slug: "c", createdAt: "" },
		];
		expect(
			rankProfiles(disabledProfiles, usage, state(), { now: 0, reservePct: 10, modelId: "gemini-3.8-flash" }),
		).toEqual(["b", "c"]);
	});

	test("banned profiles are excluded", () => {
		const usage = new Map<string, UsageSnapshot | null>([
			["a", snapshot("a", 20)],
			["b", snapshot("b", 80)],
			["c", null],
		]);
		const withBan = profiles.map(p => (p.slug === "b" ? { ...p, bannedAt: "2026-11-09T00:00:00Z" } : p));
		expect(rankProfiles(withBan, usage, state(), { now: 0, reservePct: 10, modelId: "gemini-3.8-flash" })).toEqual([
			"a",
			"c",
		]);
	});

	test("profiles below the reserve are used only as a last resort", () => {
		const usage = new Map<string, UsageSnapshot | null>([
			["a", snapshot("a", 5)],
			["b", snapshot("b", 80)],
			["c", null],
		]);
		expect(rankProfiles(profiles, usage, state(), { now: 0, reservePct: 10, modelId: "gemini-3.8-flash" })).toEqual([
			"b",
			"c",
		]);
	});

	test("anti-mubazir: drains account whose weekly quota resets soonest even if another has slightly more headroom", () => {
		const now = Date.parse("2026-11-09T00:00:00Z");
		const usage = new Map<string, UsageSnapshot | null>([
			// 'a' has 85% weekly quota resetting in 18 hours (urgent drain window)
			["a", snapshotWithWeekly("a", 80, 85, "2026-11-09T18:00:00Z")],
			// 'b' has 95% weekly quota resetting in 6 days
			["b", snapshotWithWeekly("b", 80, 95, "2026-11-15T00:00:00Z")],
			["c", null],
		]);
		expect(rankProfiles(profiles, usage, state(), { now, reservePct: 10, modelId: "gemini-3.8-flash" })).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	test("anti-mubazir: when both accounts expire soon, sooner reset wins", () => {
		const now = Date.parse("2026-11-09T00:00:00Z");
		const usage = new Map<string, UsageSnapshot | null>([
			// 'a' resets in 24 hours
			["a", snapshotWithWeekly("a", 80, 80, "2026-11-10T00:00:00Z")],
			// 'b' resets in 12 hours
			["b", snapshotWithWeekly("b", 80, 80, "2026-11-09T12:00:00Z")],
			["c", null],
		]);
		expect(rankProfiles(profiles, usage, state(), { now, reservePct: 10, modelId: "gemini-3.8-flash" })).toEqual([
			"b",
			"a",
			"c",
		]);
	});

	test("comparable weekly quota in normal week prefers sooner reset", () => {
		const now = Date.parse("2026-11-09T00:00:00Z");
		const usage = new Map<string, UsageSnapshot | null>([
			// 'a' has 75% weekly, resets in 3 days
			["a", snapshotWithWeekly("a", 80, 75, "2026-11-12T00:00:00Z")],
			// 'b' has 80% weekly, resets in 6 days
			["b", snapshotWithWeekly("b", 80, 80, "2026-11-15T00:00:00Z")],
			["c", null],
		]);
		expect(rankProfiles(profiles, usage, state(), { now, reservePct: 10, modelId: "gemini-3.8-flash" })).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	test("large weekly quota difference still prefers the account with plenty headroom", () => {
		const now = Date.parse("2026-11-09T00:00:00Z");
		const usage = new Map<string, UsageSnapshot | null>([
			// 'a' has only 20% weekly left
			["a", snapshotWithWeekly("a", 80, 20, "2026-11-12T00:00:00Z")],
			// 'b' has 95% weekly left
			["b", snapshotWithWeekly("b", 80, 95, "2026-11-15T00:00:00Z")],
			["c", null],
		]);
		expect(rankProfiles(profiles, usage, state(), { now, reservePct: 10, modelId: "gemini-3.8-flash" })).toEqual([
			"b",
			"a",
			"c",
		]);
	});

	test("filters out profiles known not to support the requested model", () => {
		const usage = new Map<string, UsageSnapshot | null>([
			["a", snapshot("a", 95)],
			["b", snapshot("b", 60)],
			["c", snapshot("c", 80)],
		]);
		const models = new Map<string, ModelsSnapshot | null>([
			["a", modelsSnapshot("a", ["gemini-3.8-flash-high"])],
			["b", modelsSnapshot("b", ["gemini-4-hydrogen-high", "gemini-3.8-flash-high"])],
			["c", modelsSnapshot("c", ["gemini-4-argon-medium", "gemini-4-hydrogen-high"])],
		]);
		expect(
			rankProfiles(profiles, usage, state(), {
				now: 0,
				reservePct: 10,
				modelId: "gemini-4-hydrogen-high",
				models,
			}),
		).toEqual(["c", "b"]);
		expect(
			rankProfiles(profiles, usage, state(), {
				now: 0,
				reservePct: 10,
				modelId: "gemini-4-argon",
				models,
			}),
		).toEqual(["c"]);
	});

	test("prefers profiles confirmed to support the model over unmeasured profiles", () => {
		const usage = new Map<string, UsageSnapshot | null>([
			["a", snapshot("a", 95)],
			["b", snapshot("b", 60)],
			["c", snapshot("c", 80)],
		]);
		const models = new Map<string, ModelsSnapshot | null>([
			["a", null],
			["b", modelsSnapshot("b", ["gemini-4-hydrogen-high"])],
			["c", modelsSnapshot("c", ["gemini-3.8-flash-high"])],
		]);
		expect(
			rankProfiles(profiles, usage, state(), {
				now: 0,
				reservePct: 10,
				modelId: "gemini-4-hydrogen-high",
				models,
			}),
		).toEqual(["b", "a"]);
	});

	test("returns empty list when all measured profiles do not support the requested model", () => {
		const usage = new Map<string, UsageSnapshot | null>([
			["a", snapshot("a", 95)],
			["b", snapshot("b", 60)],
			["c", snapshot("c", 80)],
		]);
		const models = new Map<string, ModelsSnapshot | null>([
			["a", modelsSnapshot("a", ["gemini-3.8-flash-high"])],
			["b", modelsSnapshot("b", ["gemini-3.8-flash-high"])],
			["c", modelsSnapshot("c", ["gemini-3.8-flash-high"])],
		]);
		expect(
			rankProfiles(profiles, usage, state(), {
				now: 0,
				reservePct: 10,
				modelId: "gemini-4-hydrogen-high",
				models,
			}),
		).toEqual([]);
	});
});

function modelsSnapshot(slug: string, ids: string[]): ModelsSnapshot {
	return {
		profile: slug,
		fetchedAt: 0,
		models: ids.map(modelId => ({ modelId })),
	};
}

function snapshotWithWeekly(
	slug: string,
	fiveHourPct: number,
	weeklyPct: number,
	weeklyResetsAt: string,
	fiveHourResetsAt = "2026-11-09T05:00:00Z",
): UsageSnapshot {
	return {
		profile: slug,
		fetchedAt: 0,
		raw: "",
		windows: [
			{ family: "gemini", window: "fiveHour", remainingPct: fiveHourPct, resetsAt: fiveHourResetsAt },
			{ family: "gemini", window: "weekly", remainingPct: weeklyPct, resetsAt: weeklyResetsAt },
		],
	};
}
