import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, unlinkSync } from "node:fs";
import {
	calculateCost,
	parseTranscriptTurns,
	aggregateTokens,
	renderStatsTable,
	renderPeriodTable,
	GEMINI_38_FLASH_PRICING,
	type TurnTokenUsage,
} from "../src/analytics";

describe("analytics and token usage", () => {
	it("calculates Gemini 3.8 Flash cost correctly", () => {
		// Input: $1.5/M
		expect(calculateCost(1_000_000, 0, 0)).toBeCloseTo(1.5, 4);
		// Output: $7.5/M
		expect(calculateCost(0, 1_000_000, 0)).toBeCloseTo(7.5, 4);
		// Cache read: $0.15/M
		expect(calculateCost(0, 0, 1_000_000)).toBeCloseTo(0.15, 4);
		// Combined
		const cost = calculateCost(2_000_000, 500_000, 10_000_000);
		// 2 * 1.5 + 0.5 * 7.5 + 10 * 0.15 = 3.0 + 3.75 + 1.5 = 8.25
		expect(cost).toBeCloseTo(8.25, 4);
	});

	it("parses transcript.jsonl entries correctly", () => {
		const tempFile = join(tmpdir(), `test-transcript-${Date.now()}.jsonl`);
		const nowIso = new Date().toISOString();
		const lines = [
			JSON.stringify({
				created_at: nowIso,
				input_tokens: 1000,
				output_tokens: 200,
				cache_read_tokens: 5000,
			}),
			JSON.stringify({ not_a_turn: true }),
			"invalid-json-line",
			JSON.stringify({
				created_at: nowIso,
				input_tokens: 500,
				output_tokens: 100,
			}),
		];
		writeFileSync(tempFile, lines.join("\n"));

		try {
			const turns = parseTranscriptTurns(tempFile, "test-profile", "test-conv");
			expect(turns.length).toBe(2);

			expect(turns[0]!.inputTokens).toBe(1000);
			expect(turns[0]!.outputTokens).toBe(200);
			expect(turns[0]!.cacheReadTokens).toBe(5000);
			expect(turns[0]!.totalTokens).toBe(6200);
			expect(turns[0]!.profile).toBe("test-profile");
			expect(turns[0]!.conversationId).toBe("test-conv");

			expect(turns[1]!.inputTokens).toBe(500);
			expect(turns[1]!.outputTokens).toBe(100);
			expect(turns[1]!.cacheReadTokens).toBe(0);
			expect(turns[1]!.totalTokens).toBe(600);
		} finally {
			unlinkSync(tempFile);
		}
	});

	it("aggregates tokens across today, this week, this month, and profiles", () => {
		const now = new Date(2026, 10, 10, 12, 0, 0).getTime(); // Tuesday Nov 10, 2026

		const turns: TurnTokenUsage[] = [
			// Today's turn
			{
				timestamp: now - 1000,
				isoDate: new Date(now - 1000).toISOString(),
				profile: "profile-a",
				conversationId: "conv-1",
				inputTokens: 1000,
				outputTokens: 200,
				cacheReadTokens: 500,
				totalTokens: 1700,
				cost: calculateCost(1000, 200, 500),
			},
			// Yesterday's turn (same week, same month)
			{
				timestamp: now - 24 * 3600 * 1000,
				isoDate: new Date(now - 24 * 3600 * 1000).toISOString(),
				profile: "profile-b",
				conversationId: "conv-2",
				inputTokens: 2000,
				outputTokens: 300,
				cacheReadTokens: 1000,
				totalTokens: 3300,
				cost: calculateCost(2000, 300, 1000),
			},
			// Last month's turn
			{
				timestamp: new Date(2026, 9, 15).getTime(), // Oct 15, 2026
				isoDate: new Date(2026, 9, 15).toISOString(),
				profile: "profile-a",
				conversationId: "conv-3",
				inputTokens: 5000,
				outputTokens: 1000,
				cacheReadTokens: 2000,
				totalTokens: 8000,
				cost: calculateCost(5000, 1000, 2000),
			},
		];

		const stats = aggregateTokens(turns, now);

		expect(stats.today.turns).toBe(1);
		expect(stats.today.totalTokens).toBe(1700);

		expect(stats.thisWeek.turns).toBe(2);
		expect(stats.thisWeek.totalTokens).toBe(5000);

		expect(stats.thisMonth.turns).toBe(2);
		expect(stats.thisMonth.totalTokens).toBe(5000);

		expect(stats.allTime.turns).toBe(3);
		expect(stats.allTime.totalTokens).toBe(13000);

		expect(stats.byProfile["profile-a"]!.turns).toBe(2);
		expect(stats.byProfile["profile-a"]!.totalTokens).toBe(9700);

		expect(stats.byProfile["profile-b"]!.turns).toBe(1);
		expect(stats.byProfile["profile-b"]!.totalTokens).toBe(3300);
	});

	it("renders stats tables as expected", () => {
		const now = Date.now();
		const turns: TurnTokenUsage[] = [
			{
				timestamp: now,
				isoDate: new Date(now).toISOString(),
				profile: "p1",
				conversationId: "c1",
				inputTokens: 1_000_000,
				outputTokens: 100_000,
				cacheReadTokens: 500_000,
				totalTokens: 1_600_000,
				cost: calculateCost(1_000_000, 100_000, 500_000),
			},
		];
		const stats = aggregateTokens(turns, now);
		const fullTable = renderStatsTable(stats);
		expect(fullTable).toContain("Gemini 3.8 Flash Token Usage & Cost Analytics");
		expect(fullTable).toContain("Today");
		expect(fullTable).toContain("p1");

		const periodTable = renderPeriodTable(stats.today);
		expect(periodTable).toContain("Gemini 3.8 Flash Token Usage: Today");
		expect(periodTable).toContain("1,000,000");
	});
});
