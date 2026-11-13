import { join } from "node:path";
import { AGY_BIN, profileDir } from "./paths";
import { profileEnvOf } from "./registry";
import type { ModelConfigOption, ModelInfo, ModelsSnapshot, Profile } from "./types";
import { readJson, writeJsonAtomic } from "./fs-utils";
import { hasValidAuth } from "./profile";

const EFFORT_SUFFIX_RE = /^-(low|medium|high|xhigh|max|thinking)$/i;

export function profileModelsPath(slug: string): string {
	return join(profileDir(slug), "models.json");
}

export async function readCachedModels(slug: string): Promise<ModelsSnapshot | null> {
	return await readJson<ModelsSnapshot | null>(profileModelsPath(slug), null);
}

export async function writeCachedModels(snapshot: ModelsSnapshot): Promise<void> {
	await writeJsonAtomic(profileModelsPath(snapshot.profile), snapshot);
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
		const name = match[2].trim();
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

/**
 * Whether a profile is known NOT to support `modelId`.
 * Returns false if `modelId` is omitted or the profile has no measured model list yet.
 */
export function isModelKnownUnsupported(
	snapshot: ModelsSnapshot | null | undefined,
	modelId?: string,
): boolean {
	if (!modelId || !snapshot || snapshot.models.length === 0) return false;
	return !supportsModel(snapshot, modelId);
}

/**
 * Whether `snapshot` supports `modelId` (or is unmeasured).
 */
export function supportsModel(snapshot: ModelsSnapshot | null | undefined, modelId?: string): boolean {
	if (!modelId) return true;
	if (!snapshot || snapshot.models.length === 0) return true;
	if (snapshot.models.some(m => modelIdMatches(m.modelId, modelId))) return true;
	if (snapshot.configOptions?.some(opt => opt.value === modelId)) return true;
	return false;
}

/** Whether `snapshot` has a measured model list that explicitly confirms `modelId`. */
export function isModelConfirmed(
	snapshot: ModelsSnapshot | null | undefined,
	modelId?: string,
): boolean {
	if (!modelId || !snapshot || snapshot.models.length === 0) return false;
	return supportsModel(snapshot, modelId);
}

/** Return a copy of `snapshot` with `modelId` removed (used when runtime rejects a cached model). */
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
	const merged: ModelInfo[] = [];
	const seen = new Set<string>();
	for (const list of lists) {
		if (!list) continue;
		for (const item of list) {
			if (!item.modelId || seen.has(item.modelId)) continue;
			seen.add(item.modelId);
			merged.push(item);
		}
	}
	return merged;
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
				models.push(
					typeof rec.name === "string" && rec.name
						? { modelId: rec.modelId, name: rec.name }
						: { modelId: rec.modelId },
				);
			}
		}
	}

	const configOptions: ModelConfigOption[] = [];
	if (Array.isArray(result.configOptions)) {
		for (const opt of result.configOptions) {
			if (!opt || typeof opt !== "object") continue;
			const rec = opt as Record<string, unknown>;
			if (rec.id !== "model" || !Array.isArray(rec.options)) continue;
			for (const choice of rec.options) {
				if (!choice || typeof choice !== "object") continue;
				const c = choice as Record<string, unknown>;
				if (typeof c.value !== "string" || !c.value) continue;
				configOptions.push(
					typeof c.name === "string" && c.name
						? { value: c.value, name: c.name }
						: { value: c.value },
				);
			}
		}
	}

	return { models, configOptions };
}

export async function fetchModels(
	profile: Profile,
	timeoutMs = 30_000,
	signal?: AbortSignal,
): Promise<ModelsSnapshot | null> {
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
		if (process.platform === "win32") {
			proc.kill("SIGKILL");
		} else {
			try {
				process.kill(-proc.pid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
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
		await writeCachedModels(snapshot).catch(() => {});
		return snapshot;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
	}
}
