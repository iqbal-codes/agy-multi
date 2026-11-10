import { join } from "node:path";
import { AGY_BIN, DEFAULT_BLOCK_MS, DEFAULT_RESERVE_PCT, profileDir, USAGE_TTL_MS } from "./paths";
import type { AgyResultEvent, Checkpoint, FailureKind, Profile, RunOutcome, UsageSnapshot } from "./types";
import { classifyRun } from "./classify";
import { ensureDir, run } from "./fs-utils";
import { listProfiles, profileEnvOf, profileHomeOf, saveProfile } from "./registry";
import { block, getCheckpoint, loadState, pin, pinnedProfile, saveState, setCheckpoint } from "./state";
import { blockingReset, familyForModel, fetchUsage, readCachedUsage } from "./usage";
import { rankProfiles } from "./select";
import { buildInjectedPrompt } from "./injection";

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
		"You are resuming an interrupted task on a different account.",
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
	const state = await loadState();
	const all = await listProfiles();
	if (!all.length) throw new Error("no profiles; add one with `agy-multi profile add <slug>`");
	const candidates = opts.onlyProfile ? all.filter(p => p.slug === opts.onlyProfile) : all.filter(p => !p.disabled);
	if (!candidates.length) throw new Error(`unknown profile: ${opts.onlyProfile}`);

	const family = familyForModel(opts.model);
	const now = Date.now();
	const usage = new Map<string, UsageSnapshot | null>();
	await Promise.all(
		candidates.map(async profile => {
			const disk = await readCachedUsage(profile.slug);
			if (disk && now - disk.fetchedAt < USAGE_TTL_MS) {
				usage.set(profile.slug, disk);
			} else {
				const snapshot = await fetchUsage(profile).catch(() => null);
				usage.set(profile.slug, snapshot ?? disk ?? null);
			}
		}),
	);

	const ranked = rankProfiles(candidates, usage, state, {
		modelId: opts.model,
		now,
		reservePct: DEFAULT_RESERVE_PCT,
	});
	const owner = pinnedProfile(state, opts.conversationId);
	const ordered = owner && ranked.includes(owner) ? [owner, ...ranked.filter(slug => slug !== owner)] : ranked;
	// Unknown owner (conversation created outside the wrapper): assume the first
	// ranked profile, so --conversation still resumes history instead of forking.
	const assumedOwner = owner ?? (opts.conversationId ? ordered[0] : undefined);

	const maxSwitches = opts.maxSwitches ?? 3;
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
		const profile = candidates.find(p => p.slug === slug);
		if (!profile) continue;

		// Handoff-only: never resume another account's conversation. Only the
		// profile that owns the conversation may pass --conversation.
		const canResume = Boolean(opts.conversationId && assumedOwner === slug);
		const prompt =
			opts.conversationId && !canResume
				? buildHandoffPrompt(getCheckpoint(state, opts.conversationId), basePrompt)
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
			if (conversationId) {
				pin(state, conversationId, slug);
				setCheckpoint(state, conversationId, {
					conversationId,
					prompt: opts.prompt,
					response: outcome.result?.response,
					slug,
					updatedAt: new Date().toISOString(),
					cwd: opts.cwd ?? process.cwd(),
					gitHead: await gitHead(opts.cwd ?? process.cwd()),
				});
			}
			profile.lastGenerationOkAt = new Date().toISOString();
			delete profile.bannedAt;
			delete profile.bannedReason;
			delete profile.authRequiredAt;
			await saveProfile(profile);
			await saveState(state);
			const switched = attempts.length > 1 || Boolean(opts.conversationId && assumedOwner !== profile.slug);
			return { outcome, profile, kind, switched, attempts };
		}

		last = { outcome, profile, kind };

		if (kind === "banned") {
			profile.bannedAt = new Date().toISOString();
			profile.bannedReason = "violation of Terms of Service";
			await saveProfile(profile);
			continue;
		}
		if (kind === "auth") {
			profile.authRequiredAt = new Date().toISOString();
			await saveProfile(profile);
			continue;
		}
		if (kind === "quota") {
			const until =
				blockingReset(usage.get(slug) ?? null, family, Date.now()) ?? Date.now() + DEFAULT_BLOCK_MS;
			block(state, slug, family, until);
			await saveState(state);
			continue;
		}
		// transient/error: another account will not fix it.
		break;
	}

	if (!last) throw new Error("no profile attempt was made");
	throw new RunFailure(last.outcome, last.profile, last.kind, attempts);
}
