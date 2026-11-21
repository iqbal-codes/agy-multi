import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { AccountPool, loadState, rankProfiles } from "../src/account-pool";
import { writeCachedModels } from "../src/model-catalog";
import { loadProfile, saveProfile } from "../src/registry";
import type { ModelsSnapshot, Profile, UsageSnapshot, WrapperState } from "../src/types";
import { writeCachedUsage } from "../src/usage";

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

function modelsSnapshot(slug: string, ids: string[]): ModelsSnapshot {
	return {
		profile: slug,
		fetchedAt: 0,
		models: ids.map(modelId => ({ modelId })),
	};
}

function emptyState(): WrapperState {
	return { version: 2, pins: {}, blocks: {}, checkpoints: {} };
}

describe("profile ranking", () => {
	test("more headroom first, unmeasured last", () => {
		const usage = new Map<string, UsageSnapshot | null>([
			["a", snapshot("a", 20)],
			["b", snapshot("b", 80)],
			["c", null],
		]);
		expect(rankProfiles(profiles, usage, emptyState(), { now: 0, reservePct: 10, modelId: "gemini-3.8-flash" })).toEqual([
			"b",
			"a",
			"c",
		]);
	});

	test("excludes blocked, disabled, and banned profiles", () => {
		const usage = new Map<string, UsageSnapshot | null>([
			["a", snapshot("a", 20)],
			["b", snapshot("b", 80)],
			["c", null],
		]);
		const blocked = emptyState();
		blocked.blocks.a = { gemini: 1_000 };
		expect(
			rankProfiles(profiles, usage, blocked, { now: 0, reservePct: 10, modelId: "gemini-3.8-flash" }),
		).toEqual(["b", "c"]);

		const mixed: Profile[] = [
			{ slug: "a", createdAt: "", disabled: true },
			{ slug: "b", createdAt: "", bannedAt: "2026-11-09T00:00:00Z" },
			{ slug: "c", createdAt: "" },
		];
		expect(rankProfiles(mixed, usage, emptyState(), { now: 0, reservePct: 10, modelId: "gemini-3.8-flash" })).toEqual([
			"c",
		]);
	});

	test("profiles below the reserve are used only as a last resort", () => {
		const usage = new Map<string, UsageSnapshot | null>([
			["a", snapshot("a", 5)],
			["b", snapshot("b", 80)],
			["c", null],
		]);
		expect(rankProfiles(profiles, usage, emptyState(), { now: 0, reservePct: 10, modelId: "gemini-3.8-flash" })).toEqual([
			"b",
			"c",
		]);
	});

	test("anti-mubazir drains weekly quota expiring soon first, then sooner resets", () => {
		const now = Date.parse("2026-11-09T00:00:00Z");
		const urgent = new Map<string, UsageSnapshot | null>([
			["a", snapshotWithWeekly("a", 80, 85, "2026-11-09T18:00:00Z")],
			["b", snapshotWithWeekly("b", 80, 95, "2026-11-15T00:00:00Z")],
			["c", null],
		]);
		expect(rankProfiles(profiles, urgent, emptyState(), { now, reservePct: 10, modelId: "gemini-3.8-flash" })).toEqual([
			"a",
			"b",
			"c",
		]);

		const comparable = new Map<string, UsageSnapshot | null>([
			["a", snapshotWithWeekly("a", 80, 75, "2026-11-12T00:00:00Z")],
			["b", snapshotWithWeekly("b", 80, 80, "2026-11-15T00:00:00Z")],
			["c", null],
		]);
		expect(
			rankProfiles(profiles, comparable, emptyState(), { now, reservePct: 10, modelId: "gemini-3.8-flash" }),
		).toEqual(["a", "b", "c"]);

		const largeGap = new Map<string, UsageSnapshot | null>([
			["a", snapshotWithWeekly("a", 80, 20, "2026-11-12T00:00:00Z")],
			["b", snapshotWithWeekly("b", 80, 95, "2026-11-15T00:00:00Z")],
			["c", null],
		]);
		expect(
			rankProfiles(profiles, largeGap, emptyState(), { now, reservePct: 10, modelId: "gemini-3.8-flash" }),
		).toEqual(["b", "a", "c"]);
	});

	test("filters unsupported models and prefers confirmed profiles over unmeasured", () => {
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
			rankProfiles(profiles, usage, emptyState(), {
				now: 0,
				reservePct: 10,
				modelId: "gemini-4-hydrogen-high",
				models,
			}),
		).toEqual(["b", "a"]);
	});

	test("unified reservation protects larger catalogs while baseline accounts are eligible, and releases them when baseline is blocked", () => {
		const usage = new Map<string, UsageSnapshot | null>([
			["a", snapshot("a", 40)],
			["b", snapshot("b", 99)],
			["c", snapshot("c", 30)],
		]);
		const baseline = ["gemini-3.8-flash-high", "gemini-3.8-flash-low", "claude-sonnet-4-6"];
		const premium = ["gemini-4-hydrogen-high", "gemini-4-argon-medium", ...baseline];
		const models = new Map<string, ModelsSnapshot | null>([
			["a", modelsSnapshot("a", baseline)],
			["b", modelsSnapshot("b", premium)],
			["c", modelsSnapshot("c", baseline)],
		]);

		// While a & c can serve flash, premium account b is reserved.
		expect(
			rankProfiles(profiles, usage, emptyState(), {
				now: 0,
				reservePct: 10,
				modelId: "gemini-3.8-flash-high",
				models,
			}),
		).toEqual(["a", "c"]);
		expect(
			rankProfiles(profiles, usage, emptyState(), {
				now: 0,
				reservePct: 10,
				modelId: "gemini-4-hydrogen-high",
				models,
			}),
		).toEqual(["b"]);

		// Once baseline accounts a & c are quota-blocked, b is no longer held back.
		const blocked = emptyState();
		blocked.blocks.a = { gemini: 1_000 };
		blocked.blocks.c = { gemini: 1_000 };
		expect(
			rankProfiles(profiles, usage, blocked, {
				now: 0,
				reservePct: 10,
				modelId: "gemini-3.8-flash-high",
				models,
			}),
		).toEqual(["b"]);
	});
});

describe("AccountPool module", () => {
	test("persists failure blocks/flags and clears them consistently on success", async () => {
		const root = await mkdtemp(join(tmpdir(), "agy-account-pool-"));
		const prevRoot = process.env.AGY_MULTI_ROOT;
		process.env.AGY_MULTI_ROOT = root;
		try {
			await saveProfile({ slug: "acct-a", createdAt: "2026-01-01T00:00:00Z" });
			await saveProfile({ slug: "acct-b", createdAt: "2026-01-01T00:00:00Z" });
			await writeCachedUsage(snapshot("acct-a", 90));
			await writeCachedUsage(snapshot("acct-b", 50));

			const pool = await AccountPool.load();
			const now = Date.parse("2026-11-09T00:00:00Z");

			// Quota block records expiry and drops acct-a from ranking.
			const quotaResult = await pool.recordFailure("acct-a", "quota", {
				modelId: "gemini-3.8-flash",
				usageSnapshot: {
					profile: "acct-a",
					fetchedAt: now,
					raw: "",
					windows: [{ family: "gemini", window: "fiveHour", remainingPct: 0, resetsAt: "2026-11-09T02:00:00Z" }],
				},
				now,
			});
			expect(quotaResult.blockedUntil).toBe(Date.parse("2026-11-09T02:00:00Z"));
			expect((await pool.rankCandidates({ modelId: "gemini-3.8-flash", now })).map(p => p.slug)).toEqual(["acct-b"]);

			// Auth failure marks profile.json; recordSuccess clears stale flags and pins conversation.
			await pool.recordFailure("acct-b", "auth", { now });
			expect((await loadProfile("acct-b"))?.authRequiredAt).toBeDefined();

			await pool.recordSuccess("acct-b", {
				conversationId: "conv-1",
				checkpoint: {
					conversationId: "conv-1",
					prompt: "hi",
					response: "ok",
					slug: "acct-b",
					updatedAt: "2026-11-09T00:01:00Z",
				},
				now: "2026-11-09T00:01:00Z",
			});
			const reloadedProfile = await loadProfile("acct-b");
			expect(reloadedProfile?.authRequiredAt).toBeUndefined();
			expect(reloadedProfile?.lastGenerationOkAt).toBe("2026-11-09T00:01:00Z");
			const state = await loadState();
			expect(state.pins["conv-1"]).toBe("acct-b");
			expect(state.checkpoints["conv-1"]?.prompt).toBe("hi");
		} finally {
			if (prevRoot !== undefined) process.env.AGY_MULTI_ROOT = prevRoot;
			else delete process.env.AGY_MULTI_ROOT;
			await rm(root, { recursive: true, force: true });
		}
	});

	test("sequential mode pins the busy mid-turn profile ahead of higher-quota accounts", async () => {
		const root = await mkdtemp(join(tmpdir(), "agy-account-pool-seq-"));
		const prevRoot = process.env.AGY_MULTI_ROOT;
		process.env.AGY_MULTI_ROOT = root;
		try {
			await mkdir(join(root, "profiles", "acct-a"), { recursive: true });
			await mkdir(join(root, "profiles", "acct-b"), { recursive: true });
			await writeFile(join(root, "profiles", "acct-a", "profile.json"), JSON.stringify({ slug: "acct-a", createdAt: "now" }));
			await writeFile(join(root, "profiles", "acct-b", "profile.json"), JSON.stringify({ slug: "acct-b", createdAt: "now" }));
			await writeCachedUsage(snapshot("acct-a", 5)); // below reserve!
			await writeCachedUsage(snapshot("acct-b", 95));
			await writeCachedModels(modelsSnapshot("acct-a", ["gemini-3.8-flash-high"]));
			await writeCachedModels(modelsSnapshot("acct-b", ["gemini-3.8-flash-high"]));

			const pool = await AccountPool.load();
			const ranked = await pool.rankCandidates({
				modelId: "gemini-3.8-flash-high",
				sequential: true,
				busyProfile: "acct-a",
			});
			expect(ranked[0]?.slug).toBe("acct-a");
		} finally {
			if (prevRoot !== undefined) process.env.AGY_MULTI_ROOT = prevRoot;
			else delete process.env.AGY_MULTI_ROOT;
			await rm(root, { recursive: true, force: true });
		}
	});
});
