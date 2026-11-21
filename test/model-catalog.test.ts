import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	isModelKnownUnsupported,
	mergeModelLists,
	ModelCatalog,
	parseModelsOutput,
	readCachedModels,
	reservedProfilesFor,
	supportsModel,
	writeCachedModelReasoning,
	writeCachedModels,
} from "../src/model-catalog";
import type { ModelsSnapshot, Profile } from "../src/types";

const SAMPLE_OUTPUT = [
	"\r⠋ Fetching available models...\r⠙ Fetching available models...\rgemini-4-argon-medium           Gemini 4 Argon (Medium)",
	"gemini-4-hydrogen-high          Gemini 4 Hydrogen (High)",
	"gemini-pro-orchestrator-g1-pro  Orchestrator (Argon)",
	"gemini-3.8-flash-high           Gemini 3.8 Flash (High)",
	"claude-opus-5-5-high            Claude Opus 5.5 (High)",
	"gpt-oss-120b-medium             GPT-OSS 120B (Medium)",
].join("\n");

describe("ModelCatalog parsing, matching, and reservation", () => {
	test("parses agy models output including spinner carriage returns and tabs", () => {
		expect(parseModelsOutput(SAMPLE_OUTPUT)).toEqual([
			{ modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
			{ modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
			{ modelId: "gemini-pro-orchestrator-g1-pro", name: "Orchestrator (Argon)" },
			{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
			{ modelId: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
			{ modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
		]);
		expect(parseModelsOutput("\rError: Please sign in to view available models.\n")).toEqual([]);
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
		expect(supportsModel(snap, "gemini-4")).toBe(false);
		expect(isModelKnownUnsupported(snap, "claude-opus-5-5")).toBe(true);
		expect(isModelKnownUnsupported(null, "gemini-4-hydrogen")).toBe(false);
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

	test("reserves larger catalogs for models a smaller catalog offers", () => {
		const snap = (profile: string, ids: string[]): ModelsSnapshot => ({
			profile,
			fetchedAt: 0,
			models: ids.map(modelId => ({ modelId })),
		});
		const baseline = ["gemini-3.8-flash-high", "claude-sonnet-4-6"];
		const premium = ["gemini-4-hydrogen-high", "claude-opus-5-5-high", ...baseline];
		const models = new Map<string, ModelsSnapshot | null>([
			["base", snap("base", baseline)],
			["prem", snap("prem", premium)],
			["fresh", null],
		]);
		expect([...reservedProfilesFor(models, "gemini-3.8-flash-high")]).toEqual(["prem"]);
		expect(reservedProfilesFor(models, "gemini-4-hydrogen").size).toBe(0);
	});
});

describe("ModelCatalog deep module", () => {
	test("merges cross-profile models + cached reasoning, preserves native reasoning, evicts unsupported, and filters to public Gemini", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "agy-multi-catalog-"));
		const prevRoot = process.env.AGY_MULTI_ROOT;
		process.env.AGY_MULTI_ROOT = tempRoot;
		try {
			const basic: Profile = { slug: "acct-basic", createdAt: "now" };
			const pro: Profile = { slug: "acct-pro", createdAt: "now" };
			await writeCachedModels({
				profile: "acct-basic",
				fetchedAt: Date.now(),
				models: [
					{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
					{ modelId: "claude-opus-5-5-high", name: "Claude Opus" },
				],
				configOptions: [
					{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
					{ value: "claude-opus-5-5", name: "Claude Opus" },
				],
			});
			await writeCachedModels({
				profile: "acct-pro",
				fetchedAt: Date.now(),
				models: [{ modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" }],
				configOptions: [{ value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" }],
			});
			await writeCachedModelReasoning("acct-pro", [
				{
					modelId: "gemini-4-hydrogen",
					fetchedAt: Date.now(),
					meta: {
						reasoningEfforts: [{ value: "high", label: "High" }],
						reasoningEffort: "high",
					},
				},
			]);

			const catalog = new ModelCatalog();
			await catalog.warmFromDisk([basic, pro]);

			const rawResult = {
				sessionId: "s1",
				models: {
					currentModelId: "gemini-3.8-flash",
					availableModels: [
						{
							modelId: "gemini-3.8-flash",
							name: "Gemini 3.8 Flash",
							_meta: { supportsReasoningEffort: false },
						},
					],
				},
				configOptions: [
					{
						id: "model",
						category: "model",
						currentValue: "gemini-3.8-flash",
						options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }],
					},
				],
			};

			const enriched = await catalog.enrichSessionResult(rawResult, "acct-basic", [basic, pro]);
			const filtered = catalog.filterOutbound(enriched) as {
				models: { availableModels: Array<{ modelId: string; _meta?: unknown }> };
				configOptions: Array<{ id: string; options: Array<{ value: string }> }>;
			};

			// Only public Gemini models survive outbound filtering; reasoning metadata is merged.
			const ids = filtered.models.availableModels.map(m => m.modelId);
			expect(ids).toContain("gemini-3.8-flash");
			expect(ids).toContain("gemini-4-hydrogen");
			expect(ids).not.toContain("claude-opus-5-5-high");
			expect(filtered.models.availableModels.find(m => m.modelId === "gemini-4-hydrogen")?._meta).toEqual({
				reasoningEfforts: [{ value: "high", label: "High" }],
				reasoningEffort: "high",
			});
			// Native reasoning metadata on active child is never clobbered.
			expect(filtered.models.availableModels.find(m => m.modelId === "gemini-3.8-flash")?._meta).toEqual({
				supportsReasoningEffort: false,
			});
			expect(filtered.configOptions[0]?.options.map(o => o.value)).not.toContain("claude-opus-5-5");

			// Evicting an unsupported model updates both memory and disk.
			await catalog.markUnsupported(pro, "gemini-4-hydrogen");
			const afterEvict = await readCachedModels("acct-pro");
			expect(afterEvict?.models).toEqual([]);
		} finally {
			if (prevRoot !== undefined) process.env.AGY_MULTI_ROOT = prevRoot;
			else delete process.env.AGY_MULTI_ROOT;
			await rm(tempRoot, { recursive: true, force: true });
		}
	});
});
