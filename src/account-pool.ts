import { readJson, writeJsonAtomic } from "./fs-utils";
import {
	isModelConfirmed,
	isModelKnownUnsupported,
	readCachedModels,
	reservedProfilesFor,
} from "./model-catalog";
import { DEFAULT_BLOCK_MS, DEFAULT_RESERVE_PCT, statePath } from "./paths";
import { listProfiles, saveProfile } from "./registry";
import type { Checkpoint, FailureKind, Family, ModelsSnapshot, Profile, UsageSnapshot, WrapperState } from "./types";
import { blockingReset, familyForModel, minRemaining, readCachedUsage, windowRemaining, windowReset } from "./usage";

const EMPTY_STATE: WrapperState = { version: 2, pins: {}, blocks: {}, checkpoints: {} };
const DEFAULT_EXPIRING_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

export async function loadState(): Promise<WrapperState> {
	const state = await readJson<WrapperState>(statePath(), EMPTY_STATE);
	return {
		version: 2,
		pins: state.pins ?? {},
		blocks: state.blocks ?? {},
		checkpoints: state.checkpoints ?? {},
	};
}

export async function saveState(state: WrapperState): Promise<void> {
	await writeJsonAtomic(statePath(), state);
}

export function isBlocked(state: WrapperState, slug: string, family: Family, now: number): boolean {
	const until = state.blocks[slug]?.[family];
	return typeof until === "number" && until > now;
}

export interface RankOptions {
	modelId?: string;
	now: number;
	reservePct: number;
	/** Window within which remaining weekly quota is urgent to drain before reset. Default: 48h. */
	expiringThresholdMs?: number;
	/** Optional per-profile model capability snapshots. */
	models?: Map<string, ModelsSnapshot | null>;
	/**
	 * Profiles reserved for newer models and avoided for `modelId`.
	 * When omitted, derived strictly from eligible (unblocked, above-reserve) catalogs
	 * so an unavailable baseline account never blocks a wider catalog from serving.
	 */
	reserved?: Set<string>;
}

interface Candidate {
	slug: string;
	modelConfirmed: boolean;
	measured: boolean;
	minRemaining: number;
	fiveHourRemaining?: number;
	weeklyRemaining?: number;
	weeklyReset?: number;
	blockingReset: number;
	isWeeklyExpiringSoon: boolean;
}

/**
 * Filter catalogs to profiles that can take work right now.
 * An account that is banned, signed out, disabled, blocked for the family, or
 * under the reserve must not reserve a wider catalog away from serving baseline work.
 */
export function reservableCatalogs(
	profiles: Iterable<Profile>,
	models: Map<string, ModelsSnapshot | null>,
	usage: Map<string, UsageSnapshot | null>,
	state: WrapperState,
	family: Family,
	now: number,
	reservePct: number,
): Map<string, ModelsSnapshot | null> {
	const reservable = new Map<string, ModelsSnapshot | null>();
	for (const profile of profiles) {
		if (profile.bannedAt || profile.authRequiredAt || profile.disabled) continue;
		if (isBlocked(state, profile.slug, family, now)) continue;
		const remaining = minRemaining(usage.get(profile.slug) ?? null, family);
		if (remaining !== undefined && remaining <= reservePct) continue;
		reservable.set(profile.slug, models.get(profile.slug) ?? null);
	}
	return reservable;
}

/**
 * Order candidate profiles for a turn (anti-mubazir weekly expiry, headroom, model support, reservation).
 */
export function rankProfiles(
	profiles: Profile[],
	usage: Map<string, UsageSnapshot | null>,
	state: WrapperState,
	opts: RankOptions,
): string[] {
	const family = familyForModel(opts.modelId);
	const expiringThreshold = opts.expiringThresholdMs ?? DEFAULT_EXPIRING_THRESHOLD_MS;
	const reserved =
		opts.reserved ??
		(opts.models
			? reservedProfilesFor(
					reservableCatalogs(profiles, opts.models, usage, state, family, opts.now, opts.reservePct),
					opts.modelId,
				)
			: new Set<string>());

	const candidates: Candidate[] = profiles
		.filter(p => {
			if (p.bannedAt || p.authRequiredAt || p.disabled || isBlocked(state, p.slug, family, opts.now)) {
				return false;
			}
			if (isModelKnownUnsupported(opts.models?.get(p.slug), opts.modelId)) {
				return false;
			}
			if (reserved.has(p.slug)) {
				return false;
			}
			return true;
		})
		.map(p => {
			const snapshot = usage.get(p.slug) ?? null;
			const remaining = minRemaining(snapshot, family);
			const fiveRemaining = windowRemaining(snapshot, family, "fiveHour");
			const weekRemaining = windowRemaining(snapshot, family, "weekly");
			const weekReset = windowReset(snapshot, family, "weekly");
			const reset = blockingReset(snapshot, family, opts.now);

			const isWeeklyExpiringSoon =
				weekRemaining !== undefined &&
				weekReset !== undefined &&
				weekRemaining > opts.reservePct + 5 &&
				weekReset > opts.now &&
				weekReset - opts.now <= expiringThreshold;

			return {
				slug: p.slug,
				modelConfirmed: Boolean(opts.modelId && isModelConfirmed(opts.models?.get(p.slug), opts.modelId)),
				measured: remaining !== undefined,
				minRemaining: remaining ?? 100,
				fiveHourRemaining: fiveRemaining,
				weeklyRemaining: weekRemaining,
				weeklyReset: weekReset,
				blockingReset: reset ?? Number.POSITIVE_INFINITY,
				isWeeklyExpiringSoon,
			};
		});

	const aboveReserve = candidates.filter(c => !c.measured || c.minRemaining > opts.reservePct);
	const pool = aboveReserve.length ? aboveReserve : candidates;

	pool.sort((a, b) => {
		// 0. Profiles confirmed to support the requested model strictly outrank unmeasured ones.
		if (a.modelConfirmed !== b.modelConfirmed) return a.modelConfirmed ? -1 : 1;

		// 1. Measured profiles strictly preferred over unmeasured.
		if (a.measured !== b.measured) return a.measured ? -1 : 1;

		// 2. Weekly Expiring Soon (Anti-Mubazir): drain quota about to expire before it resets.
		if (a.isWeeklyExpiringSoon !== b.isWeeklyExpiringSoon) {
			return a.isWeeklyExpiringSoon ? -1 : 1;
		}
		if (a.isWeeklyExpiringSoon && b.isWeeklyExpiringSoon) {
			const aReset = a.weeklyReset ?? a.blockingReset;
			const bReset = b.weeklyReset ?? b.blockingReset;
			const resetDiff = aReset - bReset;
			if (Math.abs(resetDiff) > 2 * 60 * 60 * 1000) return resetDiff;
			const aWeek = a.weeklyRemaining ?? a.minRemaining;
			const bWeek = b.weeklyRemaining ?? b.minRemaining;
			if (aWeek !== bWeek) return bWeek - aWeek;
		}

		// 3. Normal window: comparable weekly quota (within 25%) prefers sooner weekly reset.
		if (a.weeklyReset !== undefined && b.weeklyReset !== undefined) {
			const aWeek = a.weeklyRemaining ?? a.minRemaining;
			const bWeek = b.weeklyRemaining ?? b.minRemaining;
			if (Math.abs(aWeek - bWeek) <= 25) {
				const resetDiff = a.weeklyReset - b.weeklyReset;
				if (Math.abs(resetDiff) > 6 * 60 * 60 * 1000) return resetDiff;
			}
		}

		// 4. Default: more headroom first, then sooner blocking reset.
		if (a.minRemaining !== b.minRemaining) return b.minRemaining - a.minRemaining;
		return a.blockingReset - b.blockingReset;
	});

	return pool.map(c => c.slug);
}

export interface PoolRankOptions {
	modelId?: string;
	exclude?: string[];
	onlyProfile?: string;
	allowBlocked?: boolean;
	prefer?: string[];
	sequential?: boolean;
	busyProfile?: string;
	usage?: Map<string, UsageSnapshot | null>;
	models?: Map<string, ModelsSnapshot | null>;
	now?: number;
}

export interface RecordSuccessOptions {
	conversationId?: string;
	checkpoint?: Checkpoint;
	now?: string;
}

export interface RecordFailureOptions {
	modelId?: string;
	usageSnapshot?: UsageSnapshot | null;
	now?: number;
}

/**
 * Deep module owning configured profiles, quota blocks, conversation pins/checkpoints,
 * unified model-catalog reservation, ranking, and consistent outcome persistence.
 */
export class AccountPool {
	private readonly profiles = new Map<string, Profile>();
	private state: WrapperState = { version: 2, pins: {}, blocks: {}, checkpoints: {} };
	private readonly reservePct: number;

	constructor(options: { reservePct?: number; profiles?: Profile[]; state?: WrapperState } = {}) {
		this.reservePct = options.reservePct ?? DEFAULT_RESERVE_PCT;
		if (options.profiles) {
			for (const profile of options.profiles) this.profiles.set(profile.slug, profile);
		}
		if (options.state) this.state = options.state;
	}

	static async load(options: { reservePct?: number } = {}): Promise<AccountPool> {
		const [profiles, state] = await Promise.all([listProfiles(), loadState()]);
		return new AccountPool({ reservePct: options.reservePct, profiles, state });
	}

	get size(): number {
		return this.profiles.size;
	}

	get(slug: string): Profile | undefined {
		return this.profiles.get(slug);
	}

	list(): Profile[] {
		return [...this.profiles.values()];
	}

	getState(): WrapperState {
		return this.state;
	}

	isBlocked(slug: string, family: Family, now = Date.now()): boolean {
		return isBlocked(this.state, slug, family, now);
	}

	blockReset(slug: string, modelId?: string): number | undefined {
		const family = familyForModel(modelId);
		const direct = this.state.blocks[slug]?.[family];
		if (direct !== undefined) return direct;
		return family === "gemini" ? this.state.blocks[slug]?.["claude-gpt"] : this.state.blocks[slug]?.gemini;
	}

	isLowQuota(snapshot: UsageSnapshot | null, family: Family): boolean {
		const remaining = minRemaining(snapshot, family);
		return remaining !== undefined && remaining <= this.reservePct;
	}

	pinnedProfile(conversationId: string | undefined): string | undefined {
		return conversationId ? this.state.pins[conversationId] : undefined;
	}

	getCheckpoint(conversationId: string | undefined): Checkpoint | undefined {
		return conversationId ? this.state.checkpoints[conversationId] : undefined;
	}

	/** Healthy profiles ordered for control-plane tasks like `initialize` (no probes). */
	healthyProfiles(preferred?: string[], now = Date.now()): Profile[] {
		const candidates = this.list().filter(p => !p.bannedAt && !p.authRequiredAt && !p.disabled);
		candidates.sort((a, b) => {
			if (preferred?.length) {
				const aPref = preferred.includes(a.slug);
				const bPref = preferred.includes(b.slug);
				if (aPref !== bPref) return aPref ? -1 : 1;
			}
			const aBlocked = isBlocked(this.state, a.slug, "gemini", now);
			const bBlocked = isBlocked(this.state, b.slug, "gemini", now);
			if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;
			if (a.slug === "main") return -1;
			if (b.slug === "main") return 1;
			const aOk = a.lastGenerationOkAt ? Date.parse(a.lastGenerationOkAt) : 0;
			const bOk = b.lastGenerationOkAt ? Date.parse(b.lastGenerationOkAt) : 0;
			return bOk - aOk;
		});
		return candidates;
	}

	/** Read cached usage and model snapshots across all configured profiles in parallel. */
	async readCachedSnapshots(): Promise<{
		usage: Map<string, UsageSnapshot | null>;
		models: Map<string, ModelsSnapshot | null>;
	}> {
		const all = this.list();
		const rows = await Promise.all(
			all.map(async profile => {
				const [usage, models] = await Promise.all([
					readCachedUsage(profile.slug),
					readCachedModels(profile.slug),
				]);
				return { slug: profile.slug, usage, models };
			}),
		);
		return {
			usage: new Map(rows.map(r => [r.slug, r.usage])),
			models: new Map(rows.map(r => [r.slug, r.models])),
		};
	}

	/** Whether `slug` is reserved for newer models and should avoid serving `modelId`. */
	async isReservedFor(
		slug: string,
		modelId?: string,
		options: {
			sequential?: boolean;
			models?: Map<string, ModelsSnapshot | null>;
			usage?: Map<string, UsageSnapshot | null>;
			now?: number;
		} = {},
	): Promise<boolean> {
		if (options.sequential || !modelId) return false;
		const snapshots =
			options.models && options.usage
				? { models: options.models, usage: options.usage }
				: await this.readCachedSnapshots();
		const reservable = reservableCatalogs(
			this.list(),
			snapshots.models,
			snapshots.usage,
			this.state,
			familyForModel(modelId),
			options.now ?? Date.now(),
			this.reservePct,
		);
		return reservedProfilesFor(reservable, modelId).has(slug);
	}

	/**
	 * Unified cache-backed candidate ranking for both ACP and one-shot `run`.
	 * Never awaits a probe; callers sync caches beforehand if desired.
	 */
	async rankCandidates(options: PoolRankOptions = {}): Promise<Profile[]> {
		const all = this.list();
		const candidates = options.onlyProfile
			? all.filter(p => p.slug === options.onlyProfile)
			: all.filter(p => !options.exclude?.includes(p.slug));
		const snapshots =
			options.usage && options.models
				? { usage: options.usage, models: options.models }
				: await this.readCachedSnapshots();
		const usage = options.usage ?? snapshots.usage;
		const models = options.models ?? snapshots.models;
		const family = familyForModel(options.modelId);
		const now = options.now ?? Date.now();

		const reserved =
			options.sequential || options.onlyProfile
				? new Set<string>()
				: reservedProfilesFor(
						reservableCatalogs(all, models, usage, this.state, family, now, this.reservePct),
						options.modelId,
					);

		const slugs = rankProfiles(candidates, usage, this.state, {
			modelId: options.modelId,
			now,
			reservePct: this.reservePct,
			reserved,
			...(options.modelId && !options.onlyProfile ? { models } : {}),
		});

		const bySlug = new Map(candidates.map(profile => [profile.slug, profile]));
		let ranked = slugs.map(slug => bySlug.get(slug)).filter((profile): profile is Profile => Boolean(profile));

		if (!ranked.length && options.allowBlocked) {
			ranked = candidates
				.filter(
					profile =>
						!profile.bannedAt &&
						!profile.authRequiredAt &&
						!profile.disabled &&
						!reserved.has(profile.slug) &&
						!isModelKnownUnsupported(models.get(profile.slug), options.modelId),
				)
				.sort(
					(a, b) =>
						(this.blockReset(a.slug, options.modelId) ?? Number.POSITIVE_INFINITY) -
						(this.blockReset(b.slug, options.modelId) ?? Number.POSITIVE_INFINITY),
				);
		}

		if (options.prefer?.length) {
			const preferred = options.prefer;
			ranked = [
				...ranked.filter(profile => preferred.includes(profile.slug)),
				...ranked.filter(profile => !preferred.includes(profile.slug)),
			];
		}

		if (options.sequential && options.busyProfile) {
			const busyProfile = bySlug.get(options.busyProfile);
			const busyEligible =
				busyProfile !== undefined &&
				!busyProfile.bannedAt &&
				!busyProfile.authRequiredAt &&
				!busyProfile.disabled &&
				!isBlocked(this.state, busyProfile.slug, family, now) &&
				!isModelKnownUnsupported(models.get(busyProfile.slug), options.modelId);
			if (busyProfile && busyEligible) {
				const index = ranked.findIndex(profile => profile.slug === busyProfile.slug);
				if (index < 0) ranked = [busyProfile, ...ranked];
				else if (index > 0) ranked = [ranked[index]!, ...ranked.slice(0, index), ...ranked.slice(index + 1)];
			}
		}

		return ranked;
	}

	/** Record a successful generation: update timestamp, clear stale ban/auth flags, and persist pins/checkpoints. */
	async recordSuccess(slug: string, options: RecordSuccessOptions = {}): Promise<void> {
		const profile = this.profiles.get(slug);
		if (!profile) return;
		profile.lastGenerationOkAt = options.now ?? new Date().toISOString();
		delete profile.bannedAt;
		delete profile.bannedReason;
		delete profile.authRequiredAt;
		await saveProfile(profile);

		if (options.conversationId) {
			this.state.pins[options.conversationId] = slug;
			if (options.checkpoint) {
				this.state.checkpoints[options.conversationId] = options.checkpoint;
			}
			await saveState(this.state);
		}
	}

	/** Clear `authRequiredAt` after interactive authentication succeeds. */
	async clearAuthRequired(slug: string): Promise<void> {
		const profile = this.profiles.get(slug);
		if (!profile?.authRequiredAt) return;
		delete profile.authRequiredAt;
		await saveProfile(profile);
	}

	/** Record a generation or probe failure consistently across `profile.json` and `state.json`. */
	async recordFailure(
		slug: string,
		kind: FailureKind,
		options: RecordFailureOptions = {},
	): Promise<{ blockedUntil?: number }> {
		const profile = this.profiles.get(slug);
		if (!profile) return {};
		const now = options.now ?? Date.now();
		if (kind === "banned") {
			profile.bannedAt = new Date(now).toISOString();
			profile.bannedReason = "violation of Terms of Service";
			await saveProfile(profile);
			return {};
		}
		if (kind === "auth") {
			profile.authRequiredAt = new Date(now).toISOString();
			await saveProfile(profile);
			return {};
		}
		if (kind !== "quota") return {};

		const family = familyForModel(options.modelId);
		const until = blockingReset(options.usageSnapshot ?? null, family, now) ?? now + DEFAULT_BLOCK_MS;
		this.state.blocks[slug] ??= {};
		this.state.blocks[slug][family] = until;
		await saveState(this.state);
		return { blockedUntil: until };
	}
}
