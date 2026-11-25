import { join } from "node:path";
import { AccountPool } from "./account-pool";
import { classifyRun, isModelUnsupportedError } from "./classify";
import { ensureDir, run } from "./fs-utils";
import { buildInjectedPrompt } from "./injection";
import { ModelCatalog, readCachedModels, reservedProfilesFor } from "./model-catalog";
import { AGY_BIN, DEFAULT_RESERVE_PCT, DEFAULT_SWITCH_DELAY_MS, profileDir } from "./paths";
import { ProbeSync } from "./probe-sync";
import { profileEnvOf } from "./registry";
import type { AgyResultEvent, Checkpoint, FailureKind, ModelsSnapshot, Profile, RunOutcome, UsageSnapshot } from "./types";
import { familyForModel, readCachedUsage } from "./usage";

export function parseResult(stdout: string): AgyResultEvent | undefined {
	let last: AgyResultEvent | undefined;
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const event = JSON.parse(trimmed) as { event?: string; result?: AgyResultEvent };
			if (event.event === "result" && event.result) last = event.result;
		} catch {
			// Non-JSON progress line; ignore.
		}
	}
	return last;
}

export interface TurnOptions {
	prompt: string;
	conversationId?: string;
	model?: string;
	cwd?: string;
	logPath?: string;
	timeoutMs?: number;
	clean?: boolean;
}

export async function runTurn(profile: Profile, opts: TurnOptions): Promise<RunOutcome> {
	const logPath = opts.logPath ?? join(profileDir(profile.slug), "runs", `${Date.now()}.log`);
	await ensureDir(join(profileDir(profile.slug), "runs"));
	const args = [AGY_BIN, "-p", opts.prompt, "--output-format", "stream-json", "--log-file", logPath];
	if (opts.clean || profile.clean) args.push("--disable-slash-commands");
	if (opts.conversationId) args.push("--conversation", opts.conversationId);
	if (opts.model) args.push("--model", opts.model);
	const proc = Bun.spawn(args, {
		env: {
			...profileEnvOf(profile),
			BROWSER: "/usr/bin/true", // Safety: background runs must never launch GUI browsers
		},
		cwd: opts.cwd ?? process.cwd(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 30 * 60_000);
	try {
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;
		return { exitCode, result: parseResult(stdout), stdout, stderr, logPath };
	} finally {
		clearTimeout(timer);
	}
}

export interface FailoverOptions {
	prompt: string;
	conversationId?: string;
	model?: string;
	cwd?: string;
	maxSwitches?: number;
	onlyProfile?: string;
	clean?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	skills?: string[];
	/** Pause between failover attempts (default: 10s). */
	switchDelayMs?: number;
}

export interface RunAttempt {
	slug: string;
	kind: FailureKind;
	conversationId?: string;
}

export interface FailoverReport {
	outcome: RunOutcome;
	profile: Profile;
	kind: FailureKind;
	switched: boolean;
	attempts: RunAttempt[];
}

export class RunFailure extends Error {
	constructor(
		public readonly outcome: RunOutcome,
		public readonly profile: Profile,
		public readonly kind: FailureKind,
		public readonly attempts: RunAttempt[],
	) {
		super(`run failed on ${profile.slug}: ${kind}`);
		this.name = "RunFailure";
	}
}

async function gitHead(cwd: string): Promise<string | undefined> {
	const result = await run(["git", "rev-parse", "HEAD"], { cwd }).catch(() => null);
	if (!result || result.exitCode !== 0) return undefined;
	return result.stdout.trim() || undefined;
}

function buildHandoffPrompt(checkpoint: Checkpoint | undefined, prompt: string): string {
	if (!checkpoint) return prompt;
	const lines = [
		"Resuming an interrupted task.",
		"Previous session checkpoint:",
		`- Original task: ${checkpoint.prompt}`,
		checkpoint.response
			? `- Last known result: ${checkpoint.response.slice(0, 4000)}`
			: "- Last known result: (none)",
		checkpoint.cwd ? `- Working directory: ${checkpoint.cwd}` : "",
		checkpoint.gitHead ? `- Git HEAD: ${checkpoint.gitHead}` : "",
		"",
		"Continue from where the previous session left off. New instruction:",
		prompt,
	];
	return lines.filter(Boolean).join("\n");
}

export async function runWithFailover(opts: FailoverOptions): Promise<FailoverReport> {
	const pool = await AccountPool.load({ reservePct: DEFAULT_RESERVE_PCT });
	const all = pool.list();
	if (!all.length) throw new Error("no profiles; add one with `agy-multi profile add`");
	const candidates = opts.onlyProfile ? all.filter(p => p.slug === opts.onlyProfile) : all.filter(p => !p.disabled);
	if (!candidates.length) throw new Error(`unknown profile: ${opts.onlyProfile}`);

	const wantsModels = Boolean(opts.model && !opts.onlyProfile);
	const probes = new ProbeSync();
	await probes.syncAll(candidates, { usage: true, models: wantsModels });

	const catalog = new ModelCatalog();
	await catalog.warmFromDisk(candidates);

	const usage = new Map<string, UsageSnapshot | null>();
	const models = new Map<string, ModelsSnapshot | null>();
	await Promise.all(
		candidates.map(async profile => {
			usage.set(profile.slug, await readCachedUsage(profile.slug));
			if (wantsModels) models.set(profile.slug, await readCachedModels(profile.slug));
		}),
	);

	const rankedProfiles = await pool.rankCandidates({
		modelId: opts.model,
		onlyProfile: opts.onlyProfile,
		usage,
		models: wantsModels ? models : undefined,
	});
	if (opts.model && !opts.onlyProfile && rankedProfiles.length === 0) {
		const reserved = reservedProfilesFor(models, opts.model);
		if (reserved.size > 0) {
			throw new Error(
				`no available account for model ${opts.model}; ${[...reserved].join(", ")} reserved for newer models`,
			);
		}
		const withoutModelFilter = await pool.rankCandidates({
			modelId: opts.model,
			usage,
			models: new Map(),
		});
		if (withoutModelFilter.length > 0) {
			throw new Error(`no available account supports model ${opts.model}`);
		}
	}

	const ranked = rankedProfiles.map(p => p.slug);
	const owner = pool.pinnedProfile(opts.conversationId);
	const ordered = owner && ranked.includes(owner) ? [owner, ...ranked.filter(slug => slug !== owner)] : ranked;
	// Unknown owner (conversation created outside the wrapper): assume the first
	// ranked profile, so --conversation still resumes history instead of forking.
	const assumedOwner = owner ?? (opts.conversationId ? ordered[0] : undefined);

	const maxSwitches = opts.maxSwitches ?? 3;
	const switchDelayMs = opts.switchDelayMs ?? DEFAULT_SWITCH_DELAY_MS;
	const attempts: RunAttempt[] = [];
	let last: { outcome: RunOutcome; profile: Profile; kind: FailureKind } | undefined;

	const isClean = Boolean(opts.clean);
	const basePrompt = buildInjectedPrompt({
		prompt: opts.prompt,
		systemPrompt: opts.systemPrompt,
		appendSystemPrompt: opts.appendSystemPrompt,
		skills: opts.skills,
		clean: isClean,
	});

	for (const slug of ordered.slice(0, maxSwitches + 1)) {
		const profile = pool.get(slug);
		if (!profile) continue;

		if (attempts.length > 0 && switchDelayMs > 0) {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, switchDelayMs);
			await promise;
		}

		// Handoff-only: never resume another account's conversation.
		const canResume = Boolean(opts.conversationId && assumedOwner === slug);
		const prompt =
			opts.conversationId && !canResume
				? buildHandoffPrompt(pool.getCheckpoint(opts.conversationId), basePrompt)
				: basePrompt;

		const outcome = await runTurn(profile, {
			prompt,
			conversationId: canResume ? opts.conversationId : undefined,
			model: opts.model,
			cwd: opts.cwd,
			clean: isClean || profile.clean,
		});
		const kind = classifyRun(outcome.result?.status, outcome.stdout, outcome.stderr);
		attempts.push({ slug, kind, conversationId: outcome.result?.conversation_id });

		if (kind === "ok") {
			const conversationId = outcome.result?.conversation_id;
			const cwd = opts.cwd ?? process.cwd();
			await pool.recordSuccess(slug, {
				conversationId,
				...(conversationId
					? {
							checkpoint: {
								conversationId,
								prompt: opts.prompt,
								response: outcome.result?.response,
								slug,
								updatedAt: new Date().toISOString(),
								cwd,
								gitHead: await gitHead(cwd),
							},
						}
					: {}),
			});
			const switched = attempts.length > 1 || Boolean(opts.conversationId && assumedOwner !== profile.slug);
			return { outcome, profile, kind, switched, attempts };
		}

		last = { outcome, profile, kind };

		if (kind === "banned" || kind === "auth" || kind === "quota") {
			await pool.recordFailure(slug, kind, {
				modelId: opts.model,
				usageSnapshot: usage.get(slug) ?? null,
			});
			continue;
		}
		if (opts.model && isModelUnsupportedError(`${outcome.stdout}\n${outcome.stderr}`)) {
			const updated = await catalog.markUnsupported(profile, opts.model);
			if (updated) models.set(slug, updated);
			continue;
		}
		// transient/error: another account will not fix it.
		break;
	}

	if (!last) throw new Error("no profile attempt was made");
	throw new RunFailure(last.outcome, last.profile, last.kind, attempts);
}
