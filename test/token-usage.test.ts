import { describe, expect, it } from "bun:test";
import { getModelContextSize, estimateTokensFromHistory, readLatestTokenUsage } from "../src/acp/token-usage";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("token usage helper", () => {
	it("returns correct context window sizes for different models", () => {
		expect(getModelContextSize("gemini-3.8-flash")).toBe(1_048_576);
		expect(getModelContextSize("gemini-1.5-pro")).toBe(2_097_152);
		expect(getModelContextSize("claude-3-5-sonnet")).toBe(200_000);
		expect(getModelContextSize("gpt-4o")).toBe(128_000);
		expect(getModelContextSize(undefined)).toBe(1_048_576);
	});

	it("estimates tokens from conversation history", () => {
		const history = [
			{ role: "user", text: "Hello, can you help me?" },
			{ role: "assistant", text: "Sure! What do you need help with?" },
		];
		const tokens = estimateTokensFromHistory(history);
		expect(tokens).toBeGreaterThan(10);
	});

	it("parses latest tokens from a transcript.jsonl file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agy-test-transcript-"));
		const file = join(dir, "transcript.jsonl");

		const lines = [
			JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "hi" }),
			JSON.stringify({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", input_tokens: 500, cache_read_tokens: 1200, output_tokens: 50, content: "hello" }),
		];
		await writeFile(file, lines.join("\n") + "\n", "utf8");

		const usage = readLatestTokenUsage(file);
		expect(usage).not.toBeNull();
		expect(usage?.usedTokens).toBe(1750);
		expect(usage?.inputTokens).toBe(500);
		expect(usage?.cacheReadTokens).toBe(1200);
		expect(usage?.outputTokens).toBe(50);

		await rm(dir, { recursive: true, force: true });
	});
});
