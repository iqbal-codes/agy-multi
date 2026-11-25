import { syncProfileModelReasoning } from "./acp/model-reasoning";
import { fetchModels, readCachedModels, writeCachedModels } from "./model-catalog";
import { MODELS_TTL_MS, PROBE_SPACING_MS, USAGE_TTL_MS } from "./paths";
import type { ModelsSnapshot, Profile, UsageSnapshot } from "./types";
import { fetchUsage, readCachedUsage, writeCachedUsage, type FetchUsageOptions } from "./usage";

export interface ProbeFetchers {
	usage?: (profile: Profile, options: FetchUsageOptions) => Promise<UsageSnapshot | null>;
	models?: (
		profile: Profile,
		options: { signal?: AbortSignal; skipCacheWrite?: boolean },
	) => Promise<ModelsSnapshot | null>;
	reasoning?: (profile: Profile, force: boolean, signal?: AbortSignal) => Promise<number | undefined>;
}

export interface ProbeSyncOptions {
	/** Cancels in-flight probes on shutdown. */
	signal?: AbortSignal;
	/** Optional concurrency cap (`Infinity` by default: sync all accounts in parallel). */
	concurrency?: number;
	/** Optional delay between tasks when `concurrency` is bounded (default: `0`). */
	spacingMs?: number;
	usageTtlMs?: number;
	modelsTtlMs?: number;
	now?: () => number;
	onUsage?: (snapshot: UsageSnapshot) => void;
	onModels?: (snapshot: ModelsSnapshot) => void;
	/** The account cannot complete silent auth; callers must stop probing it. */
	onAuthRequired?: (slug: string) => void;
	/** Seam: replace child-process probes (prod `agy` CLI vs test fake). */
	fetchers?: ProbeFetchers;
}

export interface SyncAllOptions {
	usage?: boolean;
	models?: boolean;
	reasoning?: boolean;
	/** Probe even when the cache is still fresh. */
	force?: boolean;
	/** Probe usage even when its cache is still fresh, without forcing models. */
	forceUsage?: boolean;
}

export interface SyncProfileResult {
	slug: string;
	usage: UsageSnapshot | null;
	/** Whether `usage` came from a live probe during this sync (false = reused cache). */
	usageRefreshed?: boolean;
	models: ModelsSnapshot | null;
	reasoningCount?: number;
}

/**
 * Deduplicating parallel probe runner owning usage, model, and reasoning refreshes.
 *
 * By default probes run in parallel across all accounts with zero artificial spacing,
 * while identical keys join the already running probe and each probe performs a
 * single atomic cache write.
 */
export class ProbeSync {
	private readonly signal?: AbortSignal;
	private readonly concurrency: number;
	private readonly spacingMs: number;
	private readonly usageTtlMs: number;
	private readonly modelsTtlMs: number;
	private readonly now: () => number;
	private readonly onUsage?: (snapshot: UsageSnapshot) => void;
	private readonly onModels?: (snapshot: ModelsSnapshot) => void;
	private readonly onAuthRequired?: (slug: string) => void;
	private readonly fetchUsageFn: (profile: Profile, options: FetchUsageOptions) => Promise<UsageSnapshot | null>;
	private readonly fetchModelsFn: (
		profile: Profile,
		options: { signal?: AbortSignal; skipCacheWrite?: boolean },
	) => Promise<ModelsSnapshot | null>;
	private readonly fetchReasoningFn: (
		profile: Profile,
		force: boolean,
		signal?: AbortSignal,
	) => Promise<number | undefined>;

	private readonly pending = new Map<string, Promise<unknown>>();
	private readonly waiters: Array<() => void> = [];
	private active = 0;

	constructor(options: ProbeSyncOptions = {}) {
		this.signal = options.signal;
		this.concurrency =
			options.concurrency !== undefined && options.concurrency >= 1
				? Math.floor(options.concurrency)
				: Number.POSITIVE_INFINITY;
		this.spacingMs = Math.max(0, options.spacingMs ?? PROBE_SPACING_MS);
		this.usageTtlMs = options.usageTtlMs ?? USAGE_TTL_MS;
		this.modelsTtlMs = options.modelsTtlMs ?? MODELS_TTL_MS;
		this.now = options.now ?? Date.now;
		this.onUsage = options.onUsage;
		this.onModels = options.onModels;
		this.onAuthRequired = options.onAuthRequired;
		this.fetchUsageFn = options.fetchers?.usage ?? fetchUsage;
		this.fetchModelsFn = options.fetchers?.models ?? ((profile, opts) => fetchModels(profile, opts));
		this.fetchReasoningFn =
			options.fetchers?.reasoning ?? ((profile, force, signal) => syncProfileModelReasoning(profile, force, signal));
	}

	/** Number of unique in-flight or queued probe keys. */
	get size(): number {
		return this.pending.size;
	}

	/** Wait for every probe currently queued or in-flight to settle. */
	async drain(): Promise<void> {
		while (this.pending.size > 0) {
			await Promise.allSettled([...this.pending.values()]);
		}
	}

	/** Cached usage; a stale or missing entry triggers a non-blocking background refresh. */
	async usage(profile: Profile): Promise<UsageSnapshot | null> {
		const cached = await readCachedUsage(profile.slug);
		if (this.isStale(cached?.fetchedAt, this.usageTtlMs)) {
			void this.refreshUsage(profile).catch(() => {});
		}
		return cached;
	}

	/** Cached models, same contract as `usage`. */
	async models(profile: Profile): Promise<ModelsSnapshot | null> {
		const cached = await readCachedModels(profile.slug);
		if (this.isStale(cached?.fetchedAt, this.modelsTtlMs)) {
			void this.refreshModels(profile).catch(() => {});
		}
		return cached;
	}

	/** Probe one account's usage; concurrent callers for the same profile join the running probe. */
	refreshUsage(profile: Profile): Promise<UsageSnapshot | null> {
		return this.runKey(`usage:${profile.slug}`, async () => {
			const snapshot = await this.fetchUsageFn(profile, {
				signal: this.signal,
				skipCacheWrite: true,
				onNeedsLogin: () => this.onAuthRequired?.(profile.slug),
			});
			if (snapshot) {
				await writeCachedUsage(snapshot).catch(() => {});
				this.onUsage?.(snapshot);
			}
			return snapshot;
		});
	}

	/** Probe one account's models; concurrent callers for the same profile join the running probe. */
	refreshModels(profile: Profile): Promise<ModelsSnapshot | null> {
		return this.runKey(`models:${profile.slug}`, async () => {
			const snapshot = await this.fetchModelsFn(profile, {
				signal: this.signal,
				skipCacheWrite: true,
			});
			if (snapshot) {
				await writeCachedModels(snapshot).catch(() => {});
				this.onModels?.(snapshot);
			}
			return snapshot;
		});
	}

	/** Probe one account's reasoning metadata (also refreshes `models.json`); deduplicated per profile. */
	refreshReasoning(profile: Profile, force = false): Promise<number | undefined> {
		return this.runKey(`reasoning:${profile.slug}`, async () => {
			const count = await this.fetchReasoningFn(profile, force, this.signal);
			const updatedModels = await readCachedModels(profile.slug);
			if (updatedModels) this.onModels?.(updatedModels);
			return count;
		});
	}

	/**
	 * Sync all healthy accounts in parallel across usage, models, and reasoning.
	 * Stale (or forced) accounts run concurrently with zero artificial pacing by default.
	 */
	async syncAll(profiles: Profile[], options: SyncAllOptions = {}): Promise<SyncProfileResult[]> {
		const wantsUsage = options.usage ?? true;
		const wantsModels = options.models ?? false;
		const wantsReasoning = options.reasoning ?? false;
		const force = options.force ?? false;
		const forceUsage = options.forceUsage ?? force;
		const healthy = profiles.filter(profile => !profile.disabled && !profile.bannedAt && !profile.authRequiredAt);

		const ordered = await Promise.all(
			healthy.map(async profile => {
				const [usage, models] = await Promise.all([
					wantsUsage ? readCachedUsage(profile.slug) : Promise.resolve(null),
					wantsModels ? readCachedModels(profile.slug) : Promise.resolve(null),
				]);
				const times = [usage?.fetchedAt, models?.fetchedAt].filter((at): at is number => at !== undefined);
				return { profile, usage, models, at: times.length ? Math.min(...times) : 0 };
			}),
		);
		ordered.sort((a, b) => a.at - b.at);

		return await Promise.all(
			ordered.map(async ({ profile, usage: cachedUsage, models: cachedModels }): Promise<SyncProfileResult> => {
				const usageTask: Promise<{ snapshot: UsageSnapshot | null; refreshed: boolean }> =
					wantsUsage && (forceUsage || this.isStale(cachedUsage?.fetchedAt, this.usageTtlMs))
						? this.refreshUsage(profile).then(
								snapshot => ({ snapshot: snapshot ?? cachedUsage, refreshed: snapshot !== null }),
								() => ({ snapshot: cachedUsage, refreshed: false }),
							)
						: Promise.resolve({ snapshot: cachedUsage, refreshed: false });

				const catalogTask = (async (): Promise<{ models: ModelsSnapshot | null; reasoningCount?: number }> => {
					let reasoningCount: number | undefined;
					let latestModels = cachedModels;

					if (wantsReasoning) {
						reasoningCount = await this.refreshReasoning(profile, force).catch(() => undefined);
						latestModels = (await readCachedModels(profile.slug)) ?? latestModels;
					}

					if (wantsModels && (force || this.isStale(latestModels?.fetchedAt, this.modelsTtlMs))) {
						// If reasoning discovery just populated a fresh models cache, avoid a redundant `agy models` call.
						const refreshedByReasoning =
							wantsReasoning && latestModels && !this.isStale(latestModels.fetchedAt, this.modelsTtlMs);
						if (!refreshedByReasoning) {
							latestModels = (await this.refreshModels(profile).catch(() => null)) ?? latestModels;
						}
					}

					return { models: latestModels, reasoningCount };
				})();

				const [usage, catalog] = await Promise.all([usageTask, catalogTask]);
				return {
					slug: profile.slug,
					usage: usage.snapshot,
					usageRefreshed: usage.refreshed,
					models: catalog.models,
					reasoningCount: catalog.reasoningCount,
				};
			}),
		);
	}

	private runKey<T>(key: string, task: () => Promise<T>): Promise<T> {
		const existing = this.pending.get(key);
		if (existing) return existing as Promise<T>;
		const promise = (async (): Promise<T> => {
			await this.acquireSlot();
			try {
				return await task();
			} finally {
				this.pending.delete(key);
				if (this.spacingMs > 0) {
					await new Promise(resolve => setTimeout(resolve, this.spacingMs));
				}
				this.releaseSlot();
			}
		})();
		this.pending.set(key, promise);
		return promise;
	}

	private async acquireSlot(): Promise<void> {
		if (this.active < this.concurrency) {
			this.active += 1;
			return;
		}
		await new Promise<void>(resolve => this.waiters.push(resolve));
		this.active += 1;
	}

	private releaseSlot(): void {
		this.active -= 1;
		const next = this.waiters.shift();
		if (next) next();
	}

	private isStale(fetchedAt: number | undefined, ttlMs: number): boolean {
		if (!fetchedAt) return true;
		return this.now() - fetchedAt >= ttlMs;
	}
}
