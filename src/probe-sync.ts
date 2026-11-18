import { MODELS_TTL_MS, USAGE_TTL_MS } from "./paths";
import { fetchModels, readCachedModels, writeCachedModels } from "./models";
import { SerialQueue } from "./serial-queue";
import { fetchUsage, readCachedUsage, writeCachedUsage, type FetchUsageOptions } from "./usage";
import type { ModelsSnapshot, Profile, UsageSnapshot } from "./types";

export interface ProbeSyncOptions {
	/** Shared queue; probes never overlap. */
	queue?: SerialQueue;
	/** Cancels in-flight probes on shutdown. */
	signal?: AbortSignal;
	usageTtlMs?: number;
	modelsTtlMs?: number;
	now?: () => number;
	onUsage?: (snapshot: UsageSnapshot) => void;
	onModels?: (snapshot: ModelsSnapshot) => void;
	/** The account cannot complete silent auth; callers must stop probing it. */
	onAuthRequired?: (slug: string) => void;
	/** Test seam: replace the child-process probes. */
	fetchers?: {
		usage?: (profile: Profile, options: FetchUsageOptions) => Promise<UsageSnapshot | null>;
		models?: (profile: Profile, options: { signal?: AbortSignal }) => Promise<ModelsSnapshot | null>;
	};
}

export interface SyncStaleOptions {
	usage?: boolean;
	models?: boolean;
	/** Probe even when the cache is still fresh. */
	force?: boolean;
}

/**
 * Keeps the on-disk usage/models caches warm without ever probing an account on
 * demand for the caller. Reads answer from cache; every child process this class
 * starts runs through one serial queue, so a status read never becomes a burst
 * of requests across accounts.
 */
export class ProbeSync {
	readonly queue: SerialQueue;
	private readonly signal?: AbortSignal;
	private readonly usageTtlMs: number;
	private readonly modelsTtlMs: number;
	private readonly now: () => number;
	private readonly onUsage?: (snapshot: UsageSnapshot) => void;
	private readonly onModels?: (snapshot: ModelsSnapshot) => void;
	private readonly onAuthRequired?: (slug: string) => void;
	private readonly fetchUsage: (profile: Profile, options: FetchUsageOptions) => Promise<UsageSnapshot | null>;
	private readonly fetchModels: (profile: Profile, options: { signal?: AbortSignal }) => Promise<ModelsSnapshot | null>;

	constructor(options: ProbeSyncOptions = {}) {
		this.queue = options.queue ?? new SerialQueue();
		this.signal = options.signal;
		this.usageTtlMs = options.usageTtlMs ?? USAGE_TTL_MS;
		this.modelsTtlMs = options.modelsTtlMs ?? MODELS_TTL_MS;
		this.now = options.now ?? Date.now;
		this.onUsage = options.onUsage;
		this.onModels = options.onModels;
		this.onAuthRequired = options.onAuthRequired;
		this.fetchUsage = options.fetchers?.usage ?? fetchUsage;
		this.fetchModels = options.fetchers?.models ?? ((profile, opts) => fetchModels(profile, undefined, opts.signal));
	}

	/** Cached usage; a stale or missing entry schedules a serial background refresh. */
	async usage(profile: Profile): Promise<UsageSnapshot | null> {
		const cached = await readCachedUsage(profile.slug);
		if (this.isStale(cached?.fetchedAt, this.usageTtlMs)) void this.refreshUsage(profile);
		return cached;
	}

	/** Cached models, same contract as `usage`. */
	async models(profile: Profile): Promise<ModelsSnapshot | null> {
		const cached = await readCachedModels(profile.slug);
		if (this.isStale(cached?.fetchedAt, this.modelsTtlMs)) void this.refreshModels(profile);
		return cached;
	}

	/** Probe one account's usage; concurrent callers join the running probe. */
	refreshUsage(profile: Profile): Promise<UsageSnapshot | null> {
		return this.queue.run(`usage:${profile.slug}`, async () => {
			const snapshot = await this.fetchUsage(profile, {
				signal: this.signal,
				onNeedsLogin: () => this.onAuthRequired?.(profile.slug),
			});
			if (snapshot) {
				await writeCachedUsage(snapshot).catch(() => {});
				this.onUsage?.(snapshot);
			}
			return snapshot;
		});
	}

	/** Probe one account's models; concurrent callers join the running probe. */
	refreshModels(profile: Profile): Promise<ModelsSnapshot | null> {
		return this.queue.run(`models:${profile.slug}`, async () => {
			const snapshot = await this.fetchModels(profile, { signal: this.signal });
			if (snapshot) {
				await writeCachedModels(snapshot).catch(() => {});
				this.onModels?.(snapshot);
			}
			return snapshot;
		});
	}

	/**
	 * Serial pass over the accounts that need it, oldest cache first. This is the
	 * only path that is allowed to talk to the backend on more than one account,
	 * and it does so strictly one account at a time.
	 */
	async syncStale(profiles: Profile[], options: SyncStaleOptions = {}): Promise<void> {
		const wantsUsage = options.usage ?? true;
		const wantsModels = options.models ?? false;
		const force = options.force ?? false;
		const healthy = profiles.filter(profile => !profile.disabled && !profile.bannedAt && !profile.authRequiredAt);
		const ordered: Array<{ profile: Profile; at: number }> = [];
		for (const profile of healthy) {
			const usage = wantsUsage ? await readCachedUsage(profile.slug) : null;
			const models = wantsModels ? await readCachedModels(profile.slug) : null;
			const times = [usage?.fetchedAt, models?.fetchedAt].filter((at): at is number => at !== undefined);
			ordered.push({ profile, at: times.length ? Math.min(...times) : 0 });
		}
		ordered.sort((a, b) => a.at - b.at);
		for (const { profile } of ordered) {
			const usage = wantsUsage ? await readCachedUsage(profile.slug) : null;
			if (wantsUsage && (force || this.isStale(usage?.fetchedAt, this.usageTtlMs))) {
				await this.refreshUsage(profile);
			}
			const models = wantsModels ? await readCachedModels(profile.slug) : null;
			if (wantsModels && (force || this.isStale(models?.fetchedAt, this.modelsTtlMs))) {
				await this.refreshModels(profile);
			}
		}
	}

	private isStale(fetchedAt: number | undefined, ttlMs: number): boolean {
		if (!fetchedAt) return true;
		return this.now() - fetchedAt >= ttlMs;
	}
}
