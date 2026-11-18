import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AGY_BIN, MODELS_TTL_MS } from "../paths";
import { hasValidAuth } from "../profile";
import {
	deriveBaseConfigOptions,
	extractAcpModelsFromResult,
	isPublicGeminiModel,
	readAcpSelectChoices,
	readCachedModelReasoning,
	readCachedModels,
	writeCachedModelReasoning,
	writeCachedModels,
	type ModelReasoningEntry,
	type ModelReasoningMeta,
} from "../models";
import type { Profile } from "../types";
import { AcpChild, AcpRpcError } from "./child";
import { isRecord } from "./guards";
import { isNotification } from "./rpc";

const PROBE_TIMEOUT_MS = 25_000;
const CONFIG_UPDATE_TIMEOUT_MS = 500;

function findModelSelector(options: unknown): Record<string, unknown> | undefined {
	return Array.isArray(options)
		? options.find(option => isRecord(option) && (option.category === "model" || option.id === "model"))
		: undefined;
}

function reasoningMeta(options: unknown[]): ModelReasoningMeta | undefined {
	const option = options.find(item => isRecord(item) && item.category === "thought_level");
	if (!isRecord(option) || option.type !== "select") return undefined;
	const choices = readAcpSelectChoices(option.options);
	if (choices.length === 0) return undefined;
	return {
		reasoningEfforts: choices.map(choice => ({ value: choice.value, label: choice.name ?? choice.value })),
		...(choices.some(choice => choice.value === option.currentValue) && typeof option.currentValue === "string"
			? { reasoningEffort: option.currentValue }
			: {}),
	};
}

function nativeReasoningMeta(meta: Record<string, unknown> | undefined): ModelReasoningMeta | undefined {
	if (meta?.supportsReasoningEffort === false) return { supportsReasoningEffort: false };
	const levels = meta?.reasoningEfforts;
	if (!Array.isArray(levels)) return undefined;
	const choices = levels.flatMap(level =>
		isRecord(level) && typeof level.value === "string" && level.value
			? [{ value: level.value, label: typeof level.label === "string" ? level.label : level.value }]
			: [],
	);
	if (!choices.length) return undefined;
	const current = meta?.reasoningEffort;
	return {
		reasoningEfforts: choices,
		...(typeof current === "string" && choices.some(choice => choice.value === current) ? { reasoningEffort: current } : {}),
	};
}

async function within<T>(task: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	const timer = new AbortController();
	try {
		return await Promise.race([task, delay(timeoutMs, undefined, { signal: timer.signal })]);
	} finally {
		timer.abort();
	}
}

/**
 * Only called by interactive account management commands. Each probe owns an
 * ACP process and an empty session, with no prompts or user conversation state.
 */
export async function syncProfileModelReasoning(profile: Profile, force = false): Promise<number | undefined> {
	if (profile.disabled || profile.bannedAt || profile.authRequiredAt) return;
	if (!Bun.which(AGY_BIN) || !(await hasValidAuth(profile))) return;

	const [catalog, cached] = await Promise.all([readCachedModels(profile.slug), readCachedModelReasoning(profile.slug)]);
	const cutoff = Date.now() - MODELS_TTL_MS;
	const fresh = new Set(force ? [] : cached.filter(entry => entry.fetchedAt >= cutoff).map(entry => entry.modelId));
	const previousChoices = (catalog?.configOptions ?? deriveBaseConfigOptions(catalog?.models ?? []))
		.filter(choice => isPublicGeminiModel(choice.value));
	if (!force && catalog && catalog.fetchedAt >= cutoff && previousChoices.length &&
		previousChoices.every(choice => fresh.has(choice.value))) {
		return cached.filter(entry => isPublicGeminiModel(entry.modelId) && entry.meta.reasoningEfforts?.length).length;
	}

	const entries = new Map(cached.map(entry => [entry.modelId, entry]));
	const verified = new Set(fresh);
	const remember = (modelId: string, meta: ModelReasoningMeta) => {
		entries.set(modelId, { modelId, fetchedAt: Date.now(), meta } satisfies ModelReasoningEntry);
		verified.add(modelId);
	};
	const cwd = await mkdtemp(join(tmpdir(), "agy-multi-model-probe-"));
	let sessionId: string | undefined;
	let watchUpdate: ((options: unknown[]) => void) | undefined;
	let child: AcpChild | undefined;
	let closeMethod: string | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const agent = child = new AcpChild({
			profile,
			agyBin: AGY_BIN,
			extraArgs: ["--include-default-customizations=false"],
			env: { ...process.env, BROWSER: "/usr/bin/true" },
			log: () => {},
			onExit: () => {},
			onRequest: (source, request) => source.respondError(request.id, -32601, "Unavailable during model discovery"),
			onNotification: (_source, notification) => {
				if (!isNotification(notification)) return;
				const params = notification.params;
				if (!sessionId || !isRecord(params) || params.sessionId !== sessionId) return;
				const update = params.update;
				if (isRecord(update) && update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
					watchUpdate?.(update.configOptions);
				}
			},
		});
		timeout = setTimeout(() => agent.kill(), PROBE_TIMEOUT_MS);
		const initialized = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const capabilities = isRecord(initialized) && isRecord(initialized.agentCapabilities)
			? initialized.agentCapabilities.sessionCapabilities : undefined;
		if (isRecord(capabilities)) {
			closeMethod = capabilities.delete ? "session/delete" : capabilities.close ? "session/close" : undefined;
		}
		const response = await agent.request("session/new", { cwd, mcpServers: [] });
		if (response.error) throw new AcpRpcError(response.error);
		const result = response.result;
		if (!isRecord(result) || typeof result.sessionId !== "string") throw new Error("Missing probe session");
		sessionId = result.sessionId;
		const extracted = extractAcpModelsFromResult(result);
		const selector = findModelSelector(result.configOptions);
		const choices = selector ? readAcpSelectChoices(selector.options) : deriveBaseConfigOptions(extracted.models);
		const models = extracted.models.length > 0
			? extracted.models
			: choices.map(choice => ({ modelId: choice.value, name: choice.name }));
		if (models.length === 0) throw new Error("Missing model catalog");
		await writeCachedModels({ profile: profile.slug, fetchedAt: Date.now(), models, configOptions: choices });

		const modelIds = new Set([...models.map(model => model.modelId), ...choices.map(choice => choice.value)]
			.filter(isPublicGeminiModel));
		for (const id of entries.keys()) if (!modelIds.has(id)) entries.delete(id);
		for (const model of extracted.models) {
			if (!modelIds.has(model.modelId)) continue;
			const meta = nativeReasoningMeta(model._meta);
			if (meta) remember(model.modelId, meta);
		}
		const current = selector?.currentValue;
		if (isPublicGeminiModel(current) && Array.isArray(result.configOptions)) {
			const meta = reasoningMeta(result.configOptions);
			if (meta || !verified.has(current)) remember(current, meta ?? { supportsReasoningEffort: false });
		}
		try {
			if (typeof selector?.id === "string") {
				for (const { value } of choices) {
					if (!modelIds.has(value) || verified.has(value) || !agent.alive) continue;
					const update = Promise.withResolvers<unknown[]>();
					watchUpdate = options => {
						if (findModelSelector(options)?.currentValue === value) update.resolve(options);
					};
					const changed = await agent.request("session/set_config_option", { sessionId, configId: selector.id, value });
					if (changed.error) continue;
					const options = isRecord(changed.result) ? changed.result.configOptions : undefined;
					const confirmed = Array.isArray(options) && findModelSelector(options)?.currentValue === value ? options : undefined;
					const fromResponse = confirmed && reasoningMeta(confirmed);
					if (fromResponse) {
						remember(value, fromResponse);
						continue;
					}
					const fromUpdate = await within(update.promise, CONFIG_UPDATE_TIMEOUT_MS);
					if (fromUpdate || confirmed) {
						remember(value, reasoningMeta(fromUpdate ?? confirmed!) ?? { supportsReasoningEffort: false });
					}
				}
			}
		} finally {
			// Keep newer observations from a sync that finished while we were probing.
			for (const entry of await readCachedModelReasoning(profile.slug)) {
				if (modelIds.has(entry.modelId) && entry.fetchedAt > (entries.get(entry.modelId)?.fetchedAt ?? 0)) {
					entries.set(entry.modelId, entry);
				}
			}
			await writeCachedModelReasoning(profile.slug, [...entries.values()]);
		}
		return [...entries.values()].filter(entry => entry.meta.reasoningEfforts?.length).length;
	} finally {
		clearTimeout(timeout);
		if (child?.alive && sessionId && closeMethod) {
			await within(child.request(closeMethod, { sessionId }), CONFIG_UPDATE_TIMEOUT_MS).catch(() => {});
		}
		await child?.stop();
		await rm(cwd, { recursive: true, force: true });
	}
}
