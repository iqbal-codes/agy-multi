import { describe, expect, it } from "bun:test";
import { resolveSessionTokenUsage, readLatestTokenUsage } from "../src/acp/token-usage";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("token usage helper", () => {
	it("reports unavailable usage honestly when no transcript exists", () => {
		expect(resolveSessionTokenUsage(undefined, "missing")).toBeNull();
	});

	it("resolves measured session tokens without inventing capacity or cost", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agy-resolve-transcript-"));
		try {
			const logs = join(dir, ".gemini", "antigravity-cli", "brain", "s1", ".system_generated", "logs");
			await mkdir(logs, { recursive: true });
			await writeFile(join(logs, "transcript.jsonl"), JSON.stringify({ input_tokens: 200, cache_read_tokens: 300, output_tokens: 50 }));
			expect(resolveSessionTokenUsage(dir, "s1")).toEqual({ usedTokens: 550, inputTokens: 200, cacheReadTokens: 300, outputTokens: 50 });
			expect(resolveSessionTokenUsage(dir, "missing")).toBeNull();
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	it.each([70_000, 180_000])("reads the latest complete token row with %i bytes of content", async size => {
		const dir = await mkdtemp(join(tmpdir(), "agy-large-transcript-"));
		try {
			const file = join(dir, "transcript.jsonl");
			await writeFile(file, [
				JSON.stringify({ input_tokens: 999 }),
				JSON.stringify({ input_tokens: 2000, cache_read_tokens: 3000, output_tokens: 100, content: "文".repeat(size) }),
				JSON.stringify({ type: "GENERIC", content: "x".repeat(size) }),
				'{"input_tokens":',
			].join("\n"));
			expect(readLatestTokenUsage(file)?.usedTokens).toBe(5100);
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	it("context occupancy is the latest step, not cumulative billing usage", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agy-compaction-"));
		try {
			const file = join(dir, "transcript.jsonl");
			await writeFile(file, [
				JSON.stringify({ input_tokens: 5000, cache_read_tokens: 250000, output_tokens: 1000 }),
				JSON.stringify({ type: "CHECKPOINT" }),
				JSON.stringify({ input_tokens: 5000, cache_read_tokens: 29000, output_tokens: 1000 }),
			].join("\n"));
			expect(readLatestTokenUsage(file)?.usedTokens).toBe(35000);
		} finally { await rm(dir, { recursive: true, force: true }); }
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
