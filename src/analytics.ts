import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listProfiles, profileHomeOf } from "./registry";
import type { Profile } from "./types";

export interface Pricing {
	inputPerMillion: number;
	outputPerMillion: number;
	cacheReadPerMillion: number;
}

/**
 * Default Pricing for Gemini 3.8 Flash:
 * input: $1.5/M, output: $7.5/M, cache read: $0.15/M
 */
export const GEMINI_38_FLASH_PRICING: Pricing = {
	inputPerMillion: 1.5,
	outputPerMillion: 7.5,
	cacheReadPerMillion: 0.15,
};

export interface TurnTokenUsage {
	timestamp: number;
	isoDate: string;
	profile: string;
	conversationId: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	cost: number;
}

export interface PeriodStats {
	period: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	cost: number;
	turns: number;
}

export function calculateCost(
	inputTokens: number,
	outputTokens: number,
	cacheReadTokens = 0,
	pricing = GEMINI_38_FLASH_PRICING,
): number {
	const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
	const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
	const cacheCost = (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion;
	return inputCost + outputCost + cacheCost;
}

export function parseTranscriptTurns(
	filePath: string,
	profileSlug: string,
	conversationId: string,
	pricing = GEMINI_38_FLASH_PRICING,
): TurnTokenUsage[] {
	if (!existsSync(filePath)) return [];
	try {
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n");
		const turns: TurnTokenUsage[] = [];

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const item = JSON.parse(trimmed);
				if (typeof item.input_tokens === "number") {
					const inputTokens = item.input_tokens;
					const outputTokens = typeof item.output_tokens === "number" ? item.output_tokens : 0;
					const cacheReadTokens = typeof item.cache_read_tokens === "number" ? item.cache_read_tokens : 0;
					const totalTokens = inputTokens + outputTokens + cacheReadTokens;
					const isoDate = typeof item.created_at === "string" ? item.created_at : new Date().toISOString();
					const timestamp = Date.parse(isoDate) || Date.now();
					const cost = calculateCost(inputTokens, outputTokens, cacheReadTokens, pricing);

					turns.push({
						timestamp,
						isoDate,
						profile: profileSlug,
						conversationId,
						inputTokens,
						outputTokens,
						cacheReadTokens,
						totalTokens,
						cost,
					});
				}
			} catch {
				// Ignore malformed JSON line
			}
		}
		return turns;
	} catch {
		return [];
	}
}

export async function collectAllTurns(profileFilter?: string, pricing = GEMINI_38_FLASH_PRICING): Promise<TurnTokenUsage[]> {
	const profiles = await listProfiles();
	const targets = profileFilter ? profiles.filter(p => p.slug === profileFilter) : profiles;
	const allTurns: TurnTokenUsage[] = [];

	for (const profile of targets) {
		const home = profileHomeOf(profile);
		const brainPaths = [
			join(home, ".gemini", "antigravity-cli", "brain"),
			join(home, ".gemini", "brain"),
			join(home, "brain"),
		];

		for (const brainDir of brainPaths) {
			if (!existsSync(brainDir)) continue;
			try {
				const convDirs = readdirSync(brainDir, { withFileTypes: true });
				for (const dirent of convDirs) {
					if (!dirent.isDirectory()) continue;
					const convId = dirent.name;
					const transcriptPath = join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl");
					if (existsSync(transcriptPath)) {
						const turns = parseTranscriptTurns(transcriptPath, profile.slug, convId, pricing);
						allTurns.push(...turns);
					}
				}
			} catch {
				// Ignore permission or read errors
			}
		}
	}

	// Sort turns by timestamp ascending
	allTurns.sort((a, b) => a.timestamp - b.timestamp);
	return allTurns;
}

export interface AggregatedStats {
	today: PeriodStats;
	thisWeek: PeriodStats;
	thisMonth: PeriodStats;
	allTime: PeriodStats;
	byProfile: Record<string, PeriodStats>;
}

export function aggregateTokens(turns: TurnTokenUsage[], now = Date.now()): AggregatedStats {
	const nowDate = new Date(now);
	const startOfToday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
	
	// Start of this week (last 7 days rolling or Monday)
	const dayOfWeek = nowDate.getDay(); // 0 is Sunday
	const diffToMonday = (dayOfWeek + 6) % 7;
	const startOfWeek = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - diffToMonday).getTime();

	// Start of this month (1st day)
	const startOfMonth = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).getTime();

	const createEmptyPeriod = (period: string): PeriodStats => ({
		period,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		totalTokens: 0,
		cost: 0,
		turns: 0,
	});

	const addTurn = (stats: PeriodStats, turn: TurnTokenUsage) => {
		stats.inputTokens += turn.inputTokens;
		stats.outputTokens += turn.outputTokens;
		stats.cacheReadTokens += turn.cacheReadTokens;
		stats.totalTokens += turn.totalTokens;
		stats.cost += turn.cost;
		stats.turns += 1;
	};

	const today = createEmptyPeriod("Today");
	const thisWeek = createEmptyPeriod("This Week");
	const thisMonth = createEmptyPeriod("This Month");
	const allTime = createEmptyPeriod("All Time");
	const byProfile: Record<string, PeriodStats> = {};

	for (const turn of turns) {
		addTurn(allTime, turn);

		if (turn.timestamp >= startOfToday) {
			addTurn(today, turn);
		}
		if (turn.timestamp >= startOfWeek) {
			addTurn(thisWeek, turn);
		}
		if (turn.timestamp >= startOfMonth) {
			addTurn(thisMonth, turn);
		}

		if (!byProfile[turn.profile]) {
			byProfile[turn.profile] = createEmptyPeriod(turn.profile);
		}
		addTurn(byProfile[turn.profile]!, turn);
	}

	return { today, thisWeek, thisMonth, allTime, byProfile };
}

export function formatNumber(n: number): string {
	return n.toLocaleString("en-US");
}

export function formatCurrency(n: number): string {
	return `$${n.toFixed(2)}`;
}

export function renderPeriodTable(p: PeriodStats): string {
	const rows: string[] = [];
	rows.push(`=== Gemini 3.8 Flash Token Usage: ${p.period} ===`);
	rows.push("Rates: Input: $1.5/M | Output: $7.5/M | Cache Read: $0.15/M\n");
	rows.push(
		"Period".padEnd(14) +
			"Input Tokens".padStart(15) +
			"Output Tokens".padStart(15) +
			"Cache Read".padStart(16) +
			"Total Tokens".padStart(16) +
			"Est. Value".padStart(13) +
			"Turns".padStart(8),
	);
	rows.push("-".repeat(97));
	rows.push(
		p.period.padEnd(14) +
			formatNumber(p.inputTokens).padStart(15) +
			formatNumber(p.outputTokens).padStart(15) +
			formatNumber(p.cacheReadTokens).padStart(16) +
			formatNumber(p.totalTokens).padStart(16) +
			formatCurrency(p.cost).padStart(13) +
			formatNumber(p.turns).padStart(8),
	);
	return rows.join("\n");
}

export function renderStatsTable(stats: AggregatedStats): string {
	const periods = [stats.today, stats.thisWeek, stats.thisMonth, stats.allTime];
	const rows: string[] = [];
	rows.push("=== Gemini 3.8 Flash Token Usage & Cost Analytics ===");
	rows.push("Rates: Input: $1.5/M | Output: $7.5/M | Cache Read: $0.15/M\n");
	rows.push(
		"Period".padEnd(12) +
			"Input Tokens".padStart(15) +
			"Output Tokens".padStart(15) +
			"Cache Read".padStart(16) +
			"Total Tokens".padStart(16) +
			"Est. Value".padStart(13) +
			"Turns".padStart(8),
	);
	rows.push("-".repeat(95));

	for (const p of periods) {
		rows.push(
			p.period.padEnd(12) +
				formatNumber(p.inputTokens).padStart(15) +
				formatNumber(p.outputTokens).padStart(15) +
				formatNumber(p.cacheReadTokens).padStart(16) +
				formatNumber(p.totalTokens).padStart(16) +
				formatCurrency(p.cost).padStart(13) +
				formatNumber(p.turns).padStart(8),
		);
	}

	rows.push("\n--- By Profile Breakdown (All Time) ---");
	rows.push(
		"Profile".padEnd(14) +
			"Input Tokens".padStart(15) +
			"Output Tokens".padStart(15) +
			"Cache Read".padStart(16) +
			"Total Tokens".padStart(16) +
			"Est. Value".padStart(13) +
			"Turns".padStart(8),
	);
	rows.push("-".repeat(97));

	for (const [slug, p] of Object.entries(stats.byProfile)) {
		rows.push(
			slug.padEnd(14) +
				formatNumber(p.inputTokens).padStart(15) +
				formatNumber(p.outputTokens).padStart(15) +
				formatNumber(p.cacheReadTokens).padStart(16) +
				formatNumber(p.totalTokens).padStart(16) +
				formatCurrency(p.cost).padStart(13) +
				formatNumber(p.turns).padStart(8),
		);
	}

	return rows.join("\n");
}
