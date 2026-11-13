import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isModelKnownUnsupported,
	mergeModelLists,
	parseModelsOutput,
	readCachedModels,
	supportsModel,
	writeCachedModels,
} from "../src/models";
import type { ModelsSnapshot } from "../src/types";

const SAMPLE_OUTPUT = [
	"\r⠋ Fetching available models...\r⠙ Fetching available models...\rgemini-4-argon-medium           Gemini 4 Argon (Medium)",
	"gemini-4-hydrogen-high          Gemini 4 Hydrogen (High)",
	"gemini-pro-orchestrator-g1-pro  Orchestrator (Argon)",
	"gemini-3.8-flash-high           Gemini 3.8 Flash (High)",
	"claude-opus-5-5-high            Claude Opus 5.5 (High)",
	"gpt-oss-120b-medium             GPT-OSS 120B (Medium)",
].join("\n");

describe("models parsing and capability matching", () => {
	test("parses agy models output including spinner carriage returns", () => {
		const models = parseModelsOutput(SAMPLE_OUTPUT);
		expect(models).toEqual([
			{ modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
			{ modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
			{ modelId: "gemini-pro-orchestrator-g1-pro", name: "Orchestrator (Argon)" },
			{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
			{ modelId: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
			{ modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
		]);
	});

	test("parses tab-separated piped agy models output", () => {
		const piped = [
			"gemini-4-argon-medium\tGemini 4 Argon (Medium)",
			"gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)",
			"gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
		].join("\n");
		expect(parseModelsOutput(piped)).toEqual([
			{ modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
			{ modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
			{ modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
		]);
	});

	test("ignores error lines from agy models", () => {
		const models = parseModelsOutput(
			"\rError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n",
		);
		expect(models).toEqual([]);
	});

	test("supportsModel matches exact ids and base config ids with effort suffixes", () => {
		const snap: ModelsSnapshot = {
			profile: "acct-3",
			fetchedAt: 1000,
			models: [
				{ modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
				{ modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
				{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
				{ modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
			],
		};

		expect(supportsModel(snap, undefined)).toBe(true);
		expect(supportsModel(snap, "gemini-4-hydrogen-high")).toBe(true);
		expect(supportsModel(snap, "gemini-4-hydrogen")).toBe(true);
		expect(supportsModel(snap, "gemini-4-argon")).toBe(true);
		expect(supportsModel(snap, "claude-sonnet-4-6")).toBe(true);
		expect(supportsModel(snap, "gemini-4")).toBe(false);
		expect(supportsModel(snap, "claude-opus-5-5")).toBe(false);

		expect(isModelKnownUnsupported(snap, "gemini-4-hydrogen")).toBe(false);
		expect(isModelKnownUnsupported(snap, "claude-opus-5-5")).toBe(true);
		expect(isModelKnownUnsupported(null, "gemini-4-hydrogen")).toBe(false);
		expect(isModelKnownUnsupported({ profile: "x", fetchedAt: 0, models: [] }, "gemini-4-hydrogen")).toBe(false);
	});

	test("mergeModelLists deduplicates by modelId preserving order", () => {
		const merged = mergeModelLists([
			[
				{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
				{ modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
			],
			[
				{ modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
				{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
			],
		]);
		expect(merged.map(m => m.modelId)).toEqual([
			"gemini-3.8-flash-high",
			"gpt-oss-120b-medium",
			"gemini-4-hydrogen-high",
		]);
	});

	test("persists and loads cached models snapshots to disk atomically", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "agy-multi-models-"));
		const prevRoot = process.env.AGY_MULTI_ROOT;
		process.env.AGY_MULTI_ROOT = tempRoot;
		try {
			expect(await readCachedModels("test-profile")).toBeNull();
			const snapshot: ModelsSnapshot = {
				profile: "test-profile",
				fetchedAt: Date.now(),
				models: parseModelsOutput(SAMPLE_OUTPUT),
			};
			await writeCachedModels(snapshot);
			const loaded = await readCachedModels("test-profile");
			expect(loaded).not.toBeNull();
			expect(loaded?.profile).toBe("test-profile");
			expect(loaded?.models).toHaveLength(6);
		} finally {
			if (prevRoot !== undefined) process.env.AGY_MULTI_ROOT = prevRoot;
			else delete process.env.AGY_MULTI_ROOT;
			await rm(tempRoot, { recursive: true, force: true });
		}
	});
});
