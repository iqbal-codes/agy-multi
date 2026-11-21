import { describe, expect, test } from "bun:test";
import { readCachedModels, writeCachedModels } from "../src/model-catalog";
import { ProbeSync } from "../src/probe-sync";
import type { ModelsSnapshot, Profile, UsageSnapshot } from "../src/types";
import { readCachedUsage, writeCachedUsage } from "../src/usage";

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function profileOf(slug: string, extra: Partial<Profile> = {}): Profile {
	return { slug, home: `/tmp/${slug}`, createdAt: "now", ...extra } as Profile;
}

function snapshotOf(slug: string, fetchedAt: number, remainingPct = 50): UsageSnapshot {
	return {
		profile: slug,
		fetchedAt,
		windows: [{ family: "gemini", window: "fiveHour", remainingPct, resetsAt: "2027-01-01T00:00:00Z" }],
		raw: "",
	};
}

function modelsOf(slug: string, fetchedAt: number): ModelsSnapshot {
	return {
		profile: slug,
		fetchedAt,
		models: [{ modelId: "gemini-3.8-flash-high" }],
		configOptions: [],
	};
}

function tracker() {
	let active = 0;
	let peak = 0;
	return {
		async enter(delayMs = 20) {
			active += 1;
			peak = Math.max(peak, active);
			await tick(delayMs);
		},
		leave() {
			active -= 1;
		},
		get peak() {
			return peak;
		},
	};
}

describe("ProbeSync deep module", () => {
	test("stale cache is served without waiting for the background refresh", async () => {
		const profile = profileOf("stale-one");
		await writeCachedUsage(snapshotOf("stale-one", Date.now() - 60 * 60_000, 33));
		const probes = new ProbeSync({
			fetchers: {
				usage: async () => {
					await tick(50);
					return snapshotOf("stale-one", Date.now(), 99);
				},
			},
		});
		const started = Date.now();
		const snapshot = await probes.usage(profile);
		expect(Date.now() - started).toBeLessThan(40);
		expect(snapshot?.windows[0]?.remainingPct).toBe(33);
		await probes.drain();
		expect((await readCachedUsage("stale-one"))?.windows[0]?.remainingPct).toBe(99);
	});

	test("syncAll runs all accounts in parallel by default without artificial concurrency caps", async () => {
		const profiles = ["p1", "p2", "p3", "p4", "p5"].map(slug => profileOf(slug));
		const record = tracker();
		const probes = new ProbeSync({
			fetchers: {
				usage: async profile => {
					await record.enter(25);
					try {
						return snapshotOf(profile.slug, Date.now(), 80);
					} finally {
						record.leave();
					}
				},
			},
		});
		await probes.syncAll(profiles, { usage: true, force: true });
		expect(record.peak).toBe(5);
	});

	test("concurrent requests for the same profile key join one in-flight probe", async () => {
		const profile = profileOf("dedup-me");
		let runs = 0;
		const probes = new ProbeSync({
			fetchers: {
				usage: async () => {
					runs += 1;
					await tick(20);
					return snapshotOf("dedup-me", Date.now(), 75);
				},
			},
		});
		const [a, b] = await Promise.all([probes.refreshUsage(profile), probes.refreshUsage(profile)]);
		expect(runs).toBe(1);
		expect(a?.windows[0]?.remainingPct).toBe(75);
		expect(b?.windows[0]?.remainingPct).toBe(75);
	});

	test("optional concurrency=1 and spacingMs still serialize probes when explicitly requested", async () => {
		const profiles = ["s1", "s2", "s3"].map(slug => profileOf(slug));
		const record = tracker();
		const stamps: number[] = [];
		const probes = new ProbeSync({
			concurrency: 1,
			spacingMs: 20,
			fetchers: {
				usage: async profile => {
					stamps.push(Date.now());
					await record.enter(5);
					record.leave();
					return snapshotOf(profile.slug, Date.now(), 60);
				},
			},
		});
		await probes.syncAll(profiles, { usage: true, force: true });
		expect(record.peak).toBe(1);
		expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(18);
	});

	test("syncAll refreshes stale usage, models, and reasoning while skipping fresh and unusable accounts", async () => {
		const now = Date.now();
		await writeCachedUsage(snapshotOf("fresh", now - 1_000));
		await writeCachedUsage(snapshotOf("stale", now - 10 * 60_000));
		const seenUsage: string[] = [];
		const seenReasoning: string[] = [];
		const probes = new ProbeSync({
			now: () => now,
			fetchers: {
				usage: async profile => {
					seenUsage.push(profile.slug);
					return snapshotOf(profile.slug, now, 70);
				},
				models: async profile => modelsOf(profile.slug, now),
				reasoning: async profile => {
					seenReasoning.push(profile.slug);
					await writeCachedModels(modelsOf(profile.slug, now));
					return 2;
				},
			},
		});
		const results = await probes.syncAll(
			[
				profileOf("fresh"),
				profileOf("stale"),
				profileOf("banned", { bannedAt: "2026-01-01T00:00:00Z" }),
				profileOf("signed-out", { authRequiredAt: "2026-01-01T00:00:00Z" }),
				profileOf("off", { disabled: true }),
			],
			{ usage: true, models: true, reasoning: true },
		);
		expect(seenUsage).toEqual(["stale"]);
		expect(seenReasoning.sort()).toEqual(["fresh", "stale"]);
		expect(results.map(r => r.slug).sort()).toEqual(["fresh", "stale"]);
		expect((await readCachedModels("stale"))?.models[0]?.modelId).toBe("gemini-3.8-flash-high");
	});

	test("passes skipCacheWrite=true so each probe performs a single authoritative disk write", async () => {
		const flags: boolean[] = [];
		const probes = new ProbeSync({
			fetchers: {
				usage: async (_profile, opts) => {
					flags.push(Boolean(opts.skipCacheWrite));
					return snapshotOf("single-write", Date.now(), 88);
				},
				models: async (_profile, opts) => {
					flags.push(Boolean(opts.skipCacheWrite));
					return modelsOf("single-write", Date.now());
				},
			},
		});
		await probes.syncAll([profileOf("single-write")], { usage: true, models: true, force: true });
		expect(flags).toEqual([true, true]);
		expect((await readCachedUsage("single-write"))?.windows[0]?.remainingPct).toBe(88);
		expect((await readCachedModels("single-write"))?.models[0]?.modelId).toBe("gemini-3.8-flash-high");
	});

	test("interactive-login fallback reports the account via onAuthRequired", async () => {
		const signedOut: string[] = [];
		const probes = new ProbeSync({
			onAuthRequired: slug => signedOut.push(slug),
			fetchers: {
				usage: async (_profile, options) => {
					options.onNeedsLogin?.();
					return null;
				},
			},
		});
		await probes.refreshUsage(profileOf("needs-login"));
		expect(signedOut).toEqual(["needs-login"]);
	});
});
