import { join } from "node:path";
import { AGY_BIN, profileDir } from "./paths";
import { profileEnvOf } from "./registry";
import type { ModelConfigOption, ModelInfo, ModelsSnapshot, Profile } from "./types";
import { isRecord, killProcessGroup, readJson, writeJsonAtomic } from "./fs-utils";
import { hasValidAuth } from "./profile";

export interface ModelReasoningMeta {
	reasoningEfforts?: Array<{ value: string; label: string }>;
	reasoningEffort?: string;
	supportsReasoningEffort?: false;
}

export interface ModelReasoningEntry {
	modelId: string;
	fetchedAt: number;
	meta: ModelReasoningMeta;
}

export interface FetchModelsOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Skip writing `models.json` when the caller (e.g. `ProbeSync`) owns persistence. */
	skipCacheWrite?: boolean;
}

const EFFORT_SUFFIX_RE = /^-(low|medium|high|xhigh|max|thinking)$/i;

/** Public Gemini releases have versioned IDs, including their effort variants. */
export function isPublicGeminiModel(modelId: unknown): modelId is string {
	return typeof modelId === "string" && /^gemini-\d+(?:\.\d+)*(?:-[a-z0-9]+)*$/i.test(modelId);
}

export function profileModelsPath(slug: string): string {
	return join(profileDir(slug), "models.json");
}

function modelReasoningPath(slug: string): string {
	return join(profileDir(slug), "model-reasoning.json");
}

export async function readCachedModels(slug: string): Promise<ModelsSnapshot | null> {
	return await readJson<ModelsSnapshot | null>(profileModelsPath(slug), null);
}

export async function writeCachedModels(snapshot: ModelsSnapshot): Promise<void> {
	await writeJsonAtomic(profileModelsPath(snapshot.profile), snapshot);
}

export async function readCachedModelReasoning(slug: string): Promise<ModelReasoningEntry[]> {
	const entries = await readJson<unknown>(modelReasoningPath(slug), []);
	if (!Array.isArray(entries)) return [];
	return entries.filter(
		entry =>
			isRecord(entry) &&
			typeof entry.modelId === "string" &&
			typeof entry.fetchedAt === "number" &&
			isRecord(entry.meta),
	) as ModelReasoningEntry[];
}

export async function writeCachedModelReasoning(slug: string, entries: ModelReasoningEntry[]): Promise<void> {
	await writeJsonAtomic(modelReasoningPath(slug), entries);
}

/**
 * Parse `agy models` stdout lines such as:
 *   gemini-4-argon-medium           Gemini 4 Argon (Medium)
 *   gemini-4-hydrogen-high          Gemini 4 Hydrogen (High)
 */
export function parseModelsOutput(text: string): ModelInfo[] {
	const models: ModelInfo[] = [];
	const seen = new Set<string>();
	for (const rawLine of text.split(/\r?\n/)) {
		// Spinner frames overwrite on the same line using `\r`; keep only the final segment.
		const lastSegment = rawLine.split("\r").pop() ?? "";
		const trimmed = lastSegment.trim();
		if (!trimmed) continue;
		if (/^(error:|fetching available models)/i.test(trimmed)) continue;
		const match = /^([a-zA-Z0-9._:/-]+)(?:\t+|\s{2,})(.+)$/.exec(trimmed);
		if (!match) continue;
		const modelId = match[1];
		const name = match[2]!.trim();
		if (!modelId || seen.has(modelId)) continue;
		seen.add(modelId);
		models.push(name ? { modelId, name } : { modelId });
	}
	return models;
}

/**
 * Check whether a model ID matches any entry in a profile's model list.
 * Supports both exact model IDs (e.g. `gemini-4-hydrogen-high`) and base
 * config option IDs (e.g. `gemini-4-hydrogen` matching `gemini-4-hydrogen-high`).
 */
export function modelIdMatches(entryId: string, targetId: string): boolean {
	if (entryId === targetId) return true;
	if (!entryId.startsWith(`${targetId}-`)) return false;
	return EFFORT_SUFFIX_RE.test(entryId.slice(targetId.length));
}

/** Whether `snapshot` supports `modelId` (or is unmeasured). */
export function supportsModel(snapshot: ModelsSnapshot | null | undefined, modelId?: string): boolean {
	if (!modelId) return true;
	if (!snapshot || snapshot.models.length === 0) return true;
	if (snapshot.models.some(m => modelIdMatches(m.modelId, modelId))) return true;
	if (snapshot.configOptions?.some(opt => opt.value === modelId)) return true;
	return false;
}

/** Whether a profile is known NOT to support `modelId` (unmeasured returns false). */
export function isModelKnownUnsupported(
	snapshot: ModelsSnapshot | null | undefined,
	modelId?: string,
): boolean {
	if (!modelId || !snapshot || snapshot.models.length === 0) return false;
	return !supportsModel(snapshot, modelId);
}

/** Whether `snapshot` has a measured model list that explicitly confirms `modelId`. */
export function isModelConfirmed(
	snapshot: ModelsSnapshot | null | undefined,
	modelId?: string,
): boolean {
	if (!modelId || !snapshot || snapshot.models.length === 0) return false;
	return supportsModel(snapshot, modelId);
}

/**
 * Profiles with a larger model catalog are reserved for the models only they offer.
 * For a model that a smaller-catalog profile also confirms, return the larger-catalog
 * slugs so callers prefer the smaller catalog while it is usable.
 */
export function reservedProfilesFor(
	models: Map<string, ModelsSnapshot | null | undefined> | undefined,
	modelId?: string,
): Set<string> {
	const reserved = new Set<string>();
	if (!models || !modelId) return reserved;
	const confirming: Array<[string, number]> = [];
	for (const [slug, snapshot] of models) {
		if (snapshot && isModelConfirmed(snapshot, modelId)) confirming.push([slug, snapshot.models.length]);
	}
	if (confirming.length === 0) return reserved;
	const smallest = Math.min(...confirming.map(([, count]) => count));
	for (const [slug, count] of confirming) {
		if (count > smallest) reserved.add(slug);
	}
	return reserved;
}

/** Return a copy of `snapshot` with `modelId` removed (when runtime rejects a cached model). */
export function withoutUnsupportedModel(
	snapshot: ModelsSnapshot | null | undefined,
	modelId: string,
): ModelsSnapshot | null {
	if (!snapshot) return null;
	return {
		...snapshot,
		models: snapshot.models.filter(m => !modelIdMatches(m.modelId, modelId)),
		...(snapshot.configOptions
			? { configOptions: snapshot.configOptions.filter(opt => opt.value !== modelId) }
			: {}),
	};
}

export function mergeModelLists(lists: Array<ModelInfo[] | undefined>): ModelInfo[] {
	const merged = new Map<string, ModelInfo>();
	for (const list of lists) {
		if (!list) continue;
		for (const item of list) {
			if (!item.modelId) continue;
			const existing = merged.get(item.modelId);
			merged.set(
				item.modelId,
				existing === undefined
					? item
					: {
							...item,
							...existing,
						},
			);
		}
	}
	return [...merged.values()];
}

export function mergeConfigOptionLists(lists: Array<ModelConfigOption[] | undefined>): ModelConfigOption[] {
	const merged: ModelConfigOption[] = [];
	const seen = new Set<string>();
	for (const list of lists) {
		if (!list) continue;
		for (const item of list) {
			if (!item.value || seen.has(item.value)) continue;
			seen.add(item.value);
			merged.push(item);
		}
	}
	return merged;
}

export function deriveBaseConfigOptions(models: ModelInfo[]): ModelConfigOption[] {
	const merged: ModelConfigOption[] = [];
	const seen = new Set<string>();
	for (const m of models) {
		const stripped = m.modelId.replace(/-(low|medium|high|xhigh|max)$/i, "");
		if (!stripped || seen.has(stripped)) continue;
		seen.add(stripped);
		const name = m.name ? m.name.replace(/\s*\((low|medium|high|xhigh|max)\)\s*$/i, "").trim() : undefined;
		merged.push(name ? { value: stripped, name } : { value: stripped });
	}
	return merged;
}

/** ACP select options may be flat or grouped. */
export function readAcpSelectChoices(options: unknown): ModelConfigOption[] {
	if (!Array.isArray(options)) return [];
	return options.flatMap(option => {
		if (!isRecord(option)) return [];
		if (Array.isArray(option.options)) return readAcpSelectChoices(option.options);
		if (typeof option.value !== "string" || !option.value) return [];
		return [
			{
				value: option.value,
				...(typeof option.name === "string" && option.name ? { name: option.name } : {}),
			},
		];
	});
}

/** Extract `ModelInfo[]` and `ModelConfigOption[]` from an ACP `session/new` / `load` / `fork` result. */
export function extractAcpModelsFromResult(result: Record<string, unknown>): {
	models: ModelInfo[];
	configOptions: ModelConfigOption[];
} {
	const models: ModelInfo[] = [];
	const rawModels = result.models;
	if (rawModels && typeof rawModels === "object" && !Array.isArray(rawModels)) {
		const avail = (rawModels as Record<string, unknown>).availableModels;
		if (Array.isArray(avail)) {
			for (const entry of avail) {
				if (!entry || typeof entry !== "object") continue;
				const rec = entry as Record<string, unknown>;
				if (typeof rec.modelId !== "string" || !rec.modelId) continue;
				models.push({
					modelId: rec.modelId,
					...(typeof rec.name === "string" && rec.name ? { name: rec.name } : {}),
					...(typeof rec.description === "string" ? { description: rec.description } : {}),
					...(isRecord(rec._meta) ? { _meta: rec._meta } : {}),
				});
			}
		}
	}

	const configOptions: ModelConfigOption[] = [];
	if (Array.isArray(result.configOptions)) {
		for (const opt of result.configOptions) {
			if (!opt || typeof opt !== "object") continue;
			const rec = opt as Record<string, unknown>;
			if (rec.id !== "model" || !Array.isArray(rec.options)) continue;
			configOptions.push(...readAcpSelectChoices(rec.options));
		}
	}

	return { models, configOptions };
}

function filterChoices(choices: unknown[]): unknown[] {
	return choices.flatMap(choice => {
		if (!isRecord(choice)) return [];
		if (Array.isArray(choice.options)) {
			const options = filterChoices(choice.options);
			return options.length ? [{ ...choice, options }] : [];
		}
		return isPublicGeminiModel(choice.value) ? [choice] : [];
	});
}

/** Filter advertised ACP model choices to public Gemini releases while keeping currentValue intact. */
export function filterModelCatalog(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const models = value.models;
	const configOptions = value.configOptions;
	const hasModels = isRecord(models) && Array.isArray(models.availableModels);
	if (!hasModels && !Array.isArray(configOptions)) return value;
	return {
		...value,
		...(hasModels && Array.isArray(models.availableModels)
			? {
					models: {
						...models,
						availableModels: models.availableModels.filter(
							model => isRecord(model) && isPublicGeminiModel(model.modelId),
						),
					},
				}
			: {}),
		...(Array.isArray(configOptions)
			? {
					configOptions: configOptions.map(option =>
						isRecord(option) && (option.id === "model" || option.category === "model") && Array.isArray(option.options)
							? { ...option, options: filterChoices(option.options) }
							: option,
					),
				}
			: {}),
	};
}

export async function fetchModels(
	profile: Profile,
	options: FetchModelsOptions = {},
): Promise<ModelsSnapshot | null> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const signal = options.signal;
	if (signal?.aborted || profile.authRequiredAt || profile.bannedAt || profile.disabled) return null;
	if (!(await hasValidAuth(profile))) {
		return null;
	}
	if (signal?.aborted) return null;

	const proc = Bun.spawn([AGY_BIN, "models"], {
		detached: process.platform !== "win32",
		env: {
			...profileEnvOf(profile),
			BROWSER: "/usr/bin/true",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	let cancelled = false;
	const cancel = () => {
		cancelled = true;
		killProcessGroup(proc);
	};
	const timer = setTimeout(cancel, timeoutMs);
	signal?.addEventListener("abort", cancel, { once: true });
	if (signal?.aborted) cancel();
	try {
		const [stdout] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;
		if (cancelled || exitCode !== 0) return null;
		const models = parseModelsOutput(stdout);
		if (models.length === 0) return null;
		const snapshot: ModelsSnapshot = {
			profile: profile.slug,
			fetchedAt: Date.now(),
			models,
			configOptions: deriveBaseConfigOptions(models),
		};
		if (!options.skipCacheWrite) {
			await writeCachedModels(snapshot).catch(() => {});
		}
		return snapshot;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
	}
}

/**
 * Deep module owning model discovery, in-memory + disk caching, reasoning overlays,
 * unsupported-model eviction, and Gemini-only client catalog filtering.
 */
export class ModelCatalog {
	private readonly memory = new Map<string, ModelsSnapshot>();

	/** Seed in-memory snapshots from on-disk caches without probing. */
	async warmFromDisk(profiles: Iterable<Profile>): Promise<void> {
		await Promise.all(
			[...profiles].map(async profile => {
				const disk = await readCachedModels(profile.slug);
				if (disk) this.remember(disk);
			}),
		);
	}

	/** Update in-memory snapshot if newer than what is already cached. */
	remember(snapshot: ModelsSnapshot): void {
		const existing = this.memory.get(snapshot.profile);
		if (!existing || snapshot.fetchedAt >= existing.fetchedAt) {
			this.memory.set(snapshot.profile, snapshot);
		}
	}

	/** Read the freshest snapshot across memory and disk for one profile. */
	async snapshotFor(slug: string): Promise<ModelsSnapshot | null> {
		const [disk, mem] = [await readCachedModels(slug), this.memory.get(slug)];
		if (disk && (!mem || disk.fetchedAt >= mem.fetchedAt)) {
			this.memory.set(slug, disk);
			return disk;
		}
		return mem ?? null;
	}

	/** Read snapshots for every given profile in parallel. */
	async snapshotsFor(profiles: Iterable<Profile>): Promise<Map<string, ModelsSnapshot | null>> {
		const entries = await Promise.all(
			[...profiles].map(async profile => [profile.slug, await this.snapshotFor(profile.slug)] as const),
		);
		return new Map(entries);
	}

	/** Record models discovered from an ACP `session/new`, `load`, or `fork` result. */
	discoverFromAcpResult(profile: Profile, result: Record<string, unknown>): void {
		const { models, configOptions } = extractAcpModelsFromResult(result);
		if (models.length === 0) return;
		const snapshot: ModelsSnapshot = {
			profile: profile.slug,
			fetchedAt: Date.now(),
			models,
			configOptions: configOptions.length > 0 ? configOptions : deriveBaseConfigOptions(models),
		};
		this.memory.set(profile.slug, snapshot);
		void writeCachedModels(snapshot).catch(() => {});
	}

	/** Evict a rejected model from memory and disk caches. */
	async markUnsupported(profile: Profile, modelId: string): Promise<ModelsSnapshot | null> {
		const existing = this.memory.get(profile.slug) ?? (await readCachedModels(profile.slug));
		const updated = withoutUnsupportedModel(existing, modelId);
		if (updated) {
			this.memory.set(profile.slug, updated);
			await writeCachedModels(updated).catch(() => {});
		}
		return updated;
	}

	/** Merge cached models and reasoning levels across healthy profiles into an ACP session result. */
	async enrichSessionResult(
		result: Record<string, unknown>,
		activeProfile: string,
		healthyProfiles: Profile[],
	): Promise<Record<string, unknown>> {
		const catalogs = await Promise.all(
			healthyProfiles.map(async profile => {
				const [disk, reasoning] = await Promise.all([
					readCachedModels(profile.slug),
					readCachedModelReasoning(profile.slug),
				]);
				const mem = this.memory.get(profile.slug);
				const snapshot = disk && disk.fetchedAt > (mem?.fetchedAt ?? 0) ? disk : mem;
				if (snapshot) this.memory.set(profile.slug, snapshot);
				return { slug: profile.slug, snapshot, reasoning };
			}),
		);
		const healthySnapshots = catalogs
			.map(catalog => catalog.snapshot)
			.filter((s): s is ModelsSnapshot => Boolean(s && s.models.length > 0));
		if (healthySnapshots.length === 0) return result;

		const extracted = extractAcpModelsFromResult(result);
		const mergedAvailable = mergeModelLists([...healthySnapshots.map(s => s.models), extracted.models]);
		const mergedConfigChoices = mergeConfigOptionLists([
			...healthySnapshots.map(s => s.configOptions ?? deriveBaseConfigOptions(s.models)),
			extracted.configOptions,
		]);
		const reasoning = new Map(
			catalogs
				.toSorted((a, b) => Number(a.slug === activeProfile) - Number(b.slug === activeProfile))
				.flatMap(catalog => catalog.reasoning.map(entry => [entry.modelId, entry.meta] as const)),
		);
		const cachedReasoningModels = mergedConfigChoices.flatMap(choice => {
			const meta = reasoning.get(choice.value);
			return meta ? [{ modelId: choice.value, name: choice.name ?? choice.value, _meta: { ...meta } }] : [];
		});

		let nextResult: Record<string, unknown> = result;
		const models = isRecord(result.models) ? result.models : undefined;
		const modelConfig = Array.isArray(result.configOptions)
			? result.configOptions.find(opt => isRecord(opt) && opt.id === "model")
			: undefined;
		const currentModelId = models?.currentModelId ?? modelConfig?.currentValue;
		if (
			(models && mergedAvailable.length > 0) ||
			(cachedReasoningModels.length > 0 && typeof currentModelId === "string")
		) {
			const nativeModels = new Map(extracted.models.map(model => [model.modelId, model]));
			const availableModels = mergeModelLists([mergedAvailable, cachedReasoningModels]).map(model => {
				const native = nativeModels.get(model.modelId)?._meta;
				const meta = reasoning.get(model.modelId);
				const hasNativeReasoning =
					native?.supportsReasoningEffort === false || Array.isArray(native?.reasoningEfforts);
				return meta && !hasNativeReasoning
					? { ...model, _meta: { ...native, ...meta } }
					: native
						? { ...model, _meta: native }
						: model;
			});
			nextResult = {
				...nextResult,
				models: { ...models, currentModelId, availableModels },
			};
		}
		if (mergedConfigChoices.length > 0 && Array.isArray(result.configOptions)) {
			nextResult = {
				...nextResult,
				configOptions: result.configOptions.map(opt =>
					isRecord(opt) && opt.id === "model" ? { ...opt, options: mergedConfigChoices } : opt,
				),
			};
		}
		return nextResult;
	}

	/** Filter any outbound ACP payload to public Gemini releases. */
	filterOutbound<T>(value: T): T {
		return filterModelCatalog(value) as T;
	}
}
