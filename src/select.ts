import type { Profile, UsageSnapshot, WrapperState } from "./types";
import { blockingReset, familyForModel, minRemaining, windowRemaining, windowReset } from "./usage";
import { isBlocked } from "./state";

export interface RankOptions {
	modelId?: string;
	now: number;
	reservePct: number;
	/**
	 * Window in milliseconds within which remaining weekly quota is considered
	 * urgent to drain before it resets and goes to waste. Default: 48 hours.
	 */
	expiringThresholdMs?: number;
}

interface Candidate {
	slug: string;
	measured: boolean;
	minRemaining: number;
	fiveHourRemaining?: number;
	weeklyRemaining?: number;
	weeklyReset?: number;
	blockingReset: number;
	isWeeklyExpiringSoon: boolean;
}

const DEFAULT_EXPIRING_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

/**
 * Order candidate profiles for a turn.
 *
 * 1. Drop banned / auth-required / currently blocked profiles.
 * 2. Prefer usage-backed profiles; unmeasured ones rank last.
 * 3. Prioritize draining profiles whose weekly quota is expiring soon (anti-mubazir),
 *    as long as they have healthy quota remaining and are above the reserve.
 * 4. For profiles outside the urgent window with comparable quota (within 25%),
 *    prefer the one whose weekly quota resets sooner in the week.
 * 5. Default within measured profiles: most headroom first, then sooner reset.
 * 6. Profiles at or below the reserve are only used when nothing else is left.
 */
export function rankProfiles(
	profiles: Profile[],
	usage: Map<string, UsageSnapshot | null>,
	state: WrapperState,
	opts: RankOptions,
): string[] {
	const family = familyForModel(opts.modelId);
	const expiringThreshold = opts.expiringThresholdMs ?? DEFAULT_EXPIRING_THRESHOLD_MS;

	const candidates: Candidate[] = profiles
		.filter(p => !p.bannedAt && !p.authRequiredAt && !isBlocked(state, p.slug, family, opts.now))
		.map(p => {
			const snapshot = usage.get(p.slug) ?? null;
			const remaining = minRemaining(snapshot, family);
			const fiveRemaining = windowRemaining(snapshot, family, "fiveHour");
			const weekRemaining = windowRemaining(snapshot, family, "weekly");
			const weekReset = windowReset(snapshot, family, "weekly");
			const reset = blockingReset(snapshot, family, opts.now);

			// An account is "weekly expiring soon" if it has substantial quota left (> reserve + 5%)
			// and its weekly reset is coming up within the threshold window.
			const isWeeklyExpiringSoon =
				weekRemaining !== undefined &&
				weekReset !== undefined &&
				weekRemaining > opts.reservePct + 5 &&
				weekReset > opts.now &&
				weekReset - opts.now <= expiringThreshold;

			return {
				slug: p.slug,
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
		// 1. Measured profiles strictly preferred over unmeasured.
		if (a.measured !== b.measured) return a.measured ? -1 : 1;

		// 2. Weekly Expiring Soon (Anti-Mubazir):
		// If one candidate is about to reset its weekly quota soon and still has plenty left,
		// drain it first so the quota doesn't go to waste!
		if (a.isWeeklyExpiringSoon !== b.isWeeklyExpiringSoon) {
			return a.isWeeklyExpiringSoon ? -1 : 1;
		}

		if (a.isWeeklyExpiringSoon && b.isWeeklyExpiringSoon) {
			// Both are expiring soon: the one resetting sooner should be used first.
			const aReset = a.weeklyReset ?? a.blockingReset;
			const bReset = b.weeklyReset ?? b.blockingReset;
			const resetDiff = aReset - bReset;
			if (Math.abs(resetDiff) > 2 * 60 * 60 * 1000) return resetDiff;

			// If resets are within 2 hours of each other, burn the one with more remaining quota:
			const aWeek = a.weeklyRemaining ?? a.minRemaining;
			const bWeek = b.weeklyRemaining ?? b.minRemaining;
			if (aWeek !== bWeek) return bWeek - aWeek;
		}

		// 3. Normal window (neither is urgently expiring within 48h):
		// If both have weekly reset info and comparable quota (within 25% of each other),
		// prefer the one that resets sooner in the week to prevent waste.
		if (a.weeklyReset !== undefined && b.weeklyReset !== undefined) {
			const aWeek = a.weeklyRemaining ?? a.minRemaining;
			const bWeek = b.weeklyRemaining ?? b.minRemaining;
			if (Math.abs(aWeek - bWeek) <= 25) {
				const resetDiff = a.weeklyReset - b.weeklyReset;
				if (Math.abs(resetDiff) > 6 * 60 * 60 * 1000) {
					return resetDiff;
				}
			}
		}

		// 4. Default: more headroom first, then sooner blocking reset.
		if (a.minRemaining !== b.minRemaining) return b.minRemaining - a.minRemaining;
		return a.blockingReset - b.blockingReset;
	});

	return pool.map(c => c.slug);
}
