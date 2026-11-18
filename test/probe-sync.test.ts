import { describe, expect, test } from "bun:test";
import { ProbeSync } from "../src/probe-sync";
import { SerialQueue } from "../src/serial-queue";
import { readCachedUsage, writeCachedUsage } from "../src/usage";
import { readCachedModels, writeCachedModels } from "../src/models";
import type { ModelsSnapshot, Profile, UsageSnapshot } from "../src/types";

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

/** Records the peak number of concurrent probes; the whole point of the queue. */
function tracker() {
	let active = 0;
	let peak = 0;
	return {
		async enter() {
			active += 1;
			peak = Math.max(peak, active);
			await tick(10);
		},
		leave() {
			active -= 1;
		},
		get peak() {
			return peak;
		},
	};
}

describe("probe sync", () => {
	test("stale cache is served without waiting for the child process", async () => {
		const profile = profileOf("stale-one");
		await writeCachedUsage(snapshotOf("stale-one", Date.now() - 60 * 60_000, 33));
		const probes = new ProbeSync({
			queue: new SerialQueue(),
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
		await probes.queue.drain();
	});

	test("one account at a time even when every caller asks at once", async () => {
		const profiles = ["a1", "a2", "a3", "a4"].map(slug => profileOf(slug));
		const record = tracker();
		const probes = new ProbeSync({
			queue: new SerialQueue(),
			fetchers: {
				usage: async profile => {
					await record.enter();
					try {
						return snapshotOf(profile.slug, Date.now(), 80);
					} finally {
						record.leave();
					}
				},
			},
		});
		await Promise.all(profiles.map(profile => probes.usage(profile)));
		await probes.queue.drain();
		expect(record.peak).toBe(1);
	});

	test("usage and models share the same queue", async () => {
		const profile = profileOf("shared");
		const record = tracker();
		const probes = new ProbeSync({
			queue: new SerialQueue(),
			fetchers: {
				usage: async () => {
					await record.enter();
					record.leave();
					return snapshotOf("shared", Date.now());
				},
				models: async () => {
					await record.enter();
					record.leave();
					return modelsOf("shared", Date.now());
				},
			},
		});
		await Promise.all([probes.refreshUsage(profile), probes.refreshModels(profile)]);
		expect(record.peak).toBe(1);
	});

	test("syncStale probes oldest first and leaves fresh caches alone", async () => {
		const now = Date.now();
		await writeCachedUsage(snapshotOf("fresh", now - 1_000));
		await writeCachedUsage(snapshotOf("oldest", now - 10 * 60_000));
		await writeCachedUsage(snapshotOf("middle", now - 6 * 60_000));
		const seen: string[] = [];
		const probes = new ProbeSync({
			queue: new SerialQueue(),
			now: () => now,
			fetchers: {
				usage: async profile => {
					seen.push(profile.slug);
					return snapshotOf(profile.slug, now, 70);
				},
			},
		});
		await probes.syncStale([profileOf("fresh"), profileOf("middle"), profileOf("oldest")]);
		expect(seen).toEqual(["oldest", "middle"]);
	});

	test("syncStale force refreshes fresh accounts on request", async () => {
		const now = Date.now();
		await writeCachedUsage(snapshotOf("fresh", now - 1_000));
		const seen: string[] = [];
		const probes = new ProbeSync({
			queue: new SerialQueue(),
			now: () => now,
			fetchers: {
				usage: async profile => {
					seen.push(profile.slug);
					return snapshotOf(profile.slug, now, 70);
				},
			},
		});
		await probes.syncStale([profileOf("fresh")], { force: true });
		expect(seen).toEqual(["fresh"]);
	});

	test("unusable accounts are never probed", async () => {
		const seen: string[] = [];
		const probes = new ProbeSync({
			queue: new SerialQueue(),
			fetchers: {
				usage: async profile => {
					seen.push(profile.slug);
					return snapshotOf(profile.slug, Date.now());
				},
			},
		});
		await probes.syncStale([
			profileOf("banned", { bannedAt: "2026-01-01T00:00:00Z" }),
			profileOf("signed-out", { authRequiredAt: "2026-01-01T00:00:00Z" }),
			profileOf("off", { disabled: true }),
		]);
		expect(seen).toEqual([]);
	});

	test("an interactive-login fallback reports the account instead of retrying", async () => {
		const signedOut: string[] = [];
		const probes = new ProbeSync({
			queue: new SerialQueue(),
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

	test("a refreshed snapshot replaces the cached one", async () => {
		const profile = profileOf("refresh-me");
		await writeCachedUsage(snapshotOf("refresh-me", Date.now() - 60 * 60_000, 10));
		const probes = new ProbeSync({
			queue: new SerialQueue(),
			fetchers: { usage: async () => snapshotOf("refresh-me", Date.now(), 90) },
		});
		await probes.refreshUsage(profile);
		const cached = await readCachedUsage("refresh-me");
		expect(cached?.windows[0]?.remainingPct).toBe(90);
	});

	test("models caches round-trip through the store", async () => {
		await writeCachedModels(modelsOf("models-only", Date.now() - 60 * 60_000));
		const probes = new ProbeSync({
			queue: new SerialQueue(),
			fetchers: { models: async () => modelsOf("models-only", Date.now()) },
		});
		const cached = await probes.models(profileOf("models-only"));
		expect(cached?.models[0]?.modelId).toBe("gemini-3.8-flash-high");
		expect((await readCachedModels("models-only"))?.fetchedAt).toBeGreaterThan(0);
	});
});
