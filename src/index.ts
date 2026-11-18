#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { parseAcpProxyOptions } from "./acp/cli-args";
import { runAcpProxy } from "./acp/server";
import { ensureAgy } from "./setup";
import { addProfile, disableProfile, enableProfile, loginProfile, syncProfile, syncProfiles } from "./profile";
import { listProfiles, removeProfile } from "./registry";
import { runWithFailover, RunFailure } from "./runner";
import { loadState } from "./state";
import { formatMultiUsageReport, readCachedUsage } from "./usage";
import { fetchModels, readCachedModels } from "./models";
import { MODELS_TTL_MS, PROBE_SPACING_MS } from "./paths";
import { ProbeSync } from "./probe-sync";
import { SerialQueue } from "./serial-queue";
import type { Profile, UsageSnapshot } from "./types";
import { aggregateTokens, collectAllTurns, renderPeriodTable, renderStatsTable } from "./analytics";
import { runUpdateCommand } from "./update";
import { VERSION } from "./version";

/** Short age for cache lines: `42s`, `7m`, `3h`, `2d`. */
function ageText(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

/**
 * Record the first quota snapshot right after a log in. The account was just
 * verified, so one probe here means `agy-multi quota` is never empty for an
 * account the user has open in front of them.
 */
async function primeQuotaAfterLogin(profile: Profile): Promise<void> {
	if (profile.bannedAt || profile.authRequiredAt || profile.disabled) return;
	const probes = new ProbeSync({ queue: new SerialQueue({ spacingMs: PROBE_SPACING_MS }) });
	const snapshot = await probes.refreshUsage(profile).catch(() => null);
	if (!snapshot || snapshot.windows.length === 0) {
		console.log(`quota: not recorded yet — \`agy-multi quota --profile ${profile.slug} --refresh\` when needed`);
		return;
	}
	console.log(
		`quota: ${snapshot.windows.map(window => `${window.family} ${window.window} ${window.remainingPct}%`).join(", ")}`,
	);
}

const HELP = `agy-multi — run the official agy CLI across multiple isolated accounts

Usage:
  agy-multi profile add <slug> [--home <dir>] [--remote] [--no-login] [--no-canary] [--clean]
  agy-multi profile login <slug> [--remote] [--no-canary]
  agy-multi profile list
  agy-multi profile disable <slug>
  agy-multi profile enable <slug>
  agy-multi profile sync [<slug>]
  agy-multi profile remove <slug>
  agy-multi quota [--profile <slug>] [--refresh]
  agy-multi multi-usage [--profile <slug>] [--refresh]
  agy-multi models [--profile <slug>] [--refresh]
  agy-multi usage [--daily | --weekly | --monthly] [--profile <slug>] [--json]
  agy-multi acp [--sequential] [--clean] [--compaction-threshold <tokens>]
                [--switch-delay <seconds>] [--handoff-context <chars>] [-- agy acp args...]
  agy-multi run --prompt <text> [--clean] [--no-skills] [--skills <list>]
                 [--system-prompt <text|file>] [--append-system-prompt <text|file>]
                 [--conversation <id>] [--model <id>] [--profile <slug>]
                 [--cwd <dir>] [--json] [--max-switches <n>]
  agy-multi state
  agy-multi update [--check] [--force]
  agy-multi --version

Update:
  Reads the latest GitHub release, verifies its SHA-256, and replaces the
  installed agy-multi and agy-multi-acp binaries in place. --check reports
  without installing; --force reinstalls the same version. Sessions that are
  already running keep the previous binary until they restart.

Quota:
  quota and multi-usage print the cached snapshot and never start a check on
  their own. The proxy refreshes an account when it starts and finishes serving
  work, one account at a time; idle accounts are never probed. --refresh probes
  now.

ACP Options:
  --clean                        Bypasses default skills, plugins, rules bloat and slash commands.
  --compaction-threshold <tokens> Auto-compacts conversation when context reaches this limit (default: 300000, 0 to disable).
  --switch-delay <seconds>       Pause before handing a turn to another account (default: 20).
  --handoff-context <chars>      Cap the transcript replayed when a conversation cannot be resumed (default: all of it).
  --sequential                   Keep only one account active at a time; no cross-account probing.

Subagent Clean Mode & Manual Injections (ala Pi Agent):
  --clean / --no-skills          Bypasses default skills, plugins, rules bloat and slash commands.
  --skills <list>                Comma-separated skill names or directories to inject.
  --system-prompt <text|file>    Custom system prompt (text or file path).
  --append-system-prompt <file>  Additional instructions appended to prompt.

Each profile is a separate HOME; the official agy binary and its OAuth client
are never modified.

By default, \`acp\` and \`run\` use the account pool (automatic quota failover and
parallel sessions across accounts). Pass \`--sequential\` to \`acp\` to keep only
one account active at a time with automatic switching.

Note: Google's Antigravity Terms (§6) and FAQ do not permit wrapping agy inside
third-party coding agents or automating account rotation on consumer plans;
pool mode is used at your own account risk.
`;

async function main(): Promise<void> {
	const rawArgs = Bun.argv.slice(2);
	if (rawArgs[0] === "acp" && rawArgs[1] !== "--help" && rawArgs[1] !== "-h") {
		await ensureAgy({ autoInstall: true });
		await runAcpProxy(parseAcpProxyOptions(rawArgs.slice(1)));
		return;
	}

	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: {
			prompt: { type: "string" },
			conversation: { type: "string" },
			model: { type: "string" },
			profile: { type: "string" },
			"max-switches": { type: "string" },
			"switch-delay": { type: "string" },
			"allow-account-pool": { type: "boolean" },
			cwd: { type: "string" },
			json: { type: "boolean" },
			"no-canary": { type: "boolean" },
			"no-login": { type: "boolean" },
			remote: { type: "boolean" },
			home: { type: "string" },
			clean: { type: "boolean" },
			"no-skills": { type: "boolean" },
			skills: { type: "string" },
			"system-prompt": { type: "string" },
			"append-system-prompt": { type: "string" },
			daily: { type: "boolean" },
			weekly: { type: "boolean" },
			monthly: { type: "boolean" },
			refresh: { type: "boolean" },
			check: { type: "boolean" },
			force: { type: "boolean" },
			version: { type: "boolean", short: "v" },
			help: { type: "boolean", short: "h" },
		},
	});

	const [command, subcommand, ...rest] = positionals;
	if (values.version) {
		console.log(VERSION);
		return;
	}
	if (!command || values.help) {
		console.log(HELP);
		return;
	}

	if (command === "update") {
		await runUpdateCommand({ check: Boolean(values.check), force: Boolean(values.force) });
		return;
	}

	if (command === "profile") {
		if (subcommand === "add") {
			const slug = rest[0];
			if (!slug) throw new Error("usage: agy-multi profile add <slug> [--home <dir>] [--remote] [--no-login] [--no-canary] [--clean]");
			if (!values["no-login"] || !values["no-canary"]) {
				await ensureAgy();
			}
			const profile = await addProfile(slug, {
				home: values.home,
				login: !values["no-login"],
				canary: !values["no-canary"],
				remote: Boolean(values.remote),
				clean: Boolean(values.clean),
			});
			const status = profile.bannedAt
				? "banned"
				: profile.authRequiredAt
					? "auth-required"
					: profile.lastGenerationOkAt
						? "ok"
						: "unknown";
			console.log(`${profile.slug}\t${profile.email ?? "(no email)"}\t${status}`);
			if (!values["no-login"]) await primeQuotaAfterLogin(profile);
			return;
		}
		if (subcommand === "login") {
			const slug = rest[0];
			if (!slug) throw new Error("usage: agy-multi profile login <slug> [--remote] [--no-canary]");
			await ensureAgy();
			const profile = await loginProfile(slug, {
				remote: Boolean(values.remote),
				canary: !values["no-canary"],
			});
			console.log(`logged in ${profile.slug}\t${profile.email ?? "(no email)"}`);
			await primeQuotaAfterLogin(profile);
			return;
		}
		if (subcommand === "list") {
			const profiles = await listProfiles();
			if (!profiles.length) {
				console.log("no profiles");
				return;
			}
			for (const profile of profiles) {
				const status = profile.disabled
					? "disabled"
					: profile.bannedAt
						? "banned"
						: profile.authRequiredAt
							? "auth-required"
							: profile.lastGenerationOkAt
								? "ok"
								: "unknown";
				console.log(
					`${profile.slug}\t${profile.email ?? "(no email)"}\t${status}\tlastOk=${profile.lastGenerationOkAt ?? "-"}`,
				);
			}
			return;
		}
		if (subcommand === "disable") {
			const slug = rest[0];
			if (!slug) throw new Error("usage: agy-multi profile disable <slug>");
			const profile = await disableProfile(slug);
			console.log(`disabled ${profile.slug}`);
			return;
		}
		if (subcommand === "enable") {
			const slug = rest[0];
			if (!slug) throw new Error("usage: agy-multi profile enable <slug>");
			const profile = await enableProfile(slug);
			console.log(`enabled ${profile.slug}`);
			return;
		}
		if (subcommand === "sync") {
			const slug = rest[0];
			if (slug) {
				const ok = await syncProfile(slug);
				if (!ok) throw new Error(`profile not found or has custom home: ${slug}`);
				console.log(`synced ${slug}`);
			} else {
				const synced = await syncProfiles();
				console.log(`synced ${synced.length} profile(s): ${synced.join(", ")}`);
			}
			return;
		}
		if (subcommand === "remove") {
			const slug = rest[0];
			if (!slug) throw new Error("usage: agy-multi profile remove <slug>");
			await removeProfile(slug);
			console.log(`removed ${slug}`);
			return;
		}
		throw new Error(`unknown profile command: ${subcommand ?? "(none)"}`);
	}

	if (command === "quota") {
		const profiles = (await listProfiles()).filter(p => !values.profile || p.slug === values.profile);
		if (!profiles.length) {
			console.log("no profiles");
			return;
		}
		if (values.refresh) {
			await ensureAgy();
			const probes = new ProbeSync({ queue: new SerialQueue({ spacingMs: PROBE_SPACING_MS }) });
			await probes.syncStale(profiles, { usage: true, force: true });
		}
		let oldest: number | undefined;
		for (const profile of profiles) {
			const snapshot = await readCachedUsage(profile.slug);
			if (!snapshot) {
				console.log(`${profile.slug}\t(no cached usage; run with --refresh)`);
				continue;
			}
			oldest = Math.min(oldest ?? snapshot.fetchedAt, snapshot.fetchedAt);
			for (const window of snapshot.windows) {
				console.log(
					`${profile.slug}\t${window.family}\t${window.window}\t${window.remainingPct}%\t${window.resetsAt}`,
				);
			}
		}
		if (oldest !== undefined) {
			console.error(
				`# cached ${ageText(Date.now() - oldest)} ago; ${values.refresh ? "refreshed one account at a time" : "--refresh syncs one account at a time"}`,
			);
		}
		return;
	}

	if (command === "multi-usage") {
		const profiles = (await listProfiles()).filter(p => !values.profile || p.slug === values.profile);
		if (values.refresh) {
			await ensureAgy();
			const probes = new ProbeSync({ queue: new SerialQueue({ spacingMs: PROBE_SPACING_MS }) });
			await probes.syncStale(profiles, { usage: true, force: true });
		}
		const entries: Array<{ profile: Profile; snapshot: UsageSnapshot | null }> = [];
		for (const profile of profiles) {
			entries.push({ profile, snapshot: await readCachedUsage(profile.slug) });
		}
		console.log(formatMultiUsageReport(entries));
		return;
	}

	if (command === "models") {
		await ensureAgy();
		const profiles = (await listProfiles()).filter(p => !values.profile || p.slug === values.profile);
		if (!profiles.length) {
			console.log("no profiles");
			return;
		}
		const now = Date.now();
		for (const profile of profiles) {
			const cached = values.refresh ? null : await readCachedModels(profile.slug);
			const fresh =
				cached && now - cached.fetchedAt < MODELS_TTL_MS
					? cached
					: await fetchModels(profile).catch(() => null);
			const snapshot = fresh ?? cached;
			if (!snapshot || snapshot.models.length === 0) {
				console.log(`${profile.slug}\t(unavailable)`);
				continue;
			}
			for (const model of snapshot.models) {
				console.log(`${profile.slug}\t${model.modelId}\t${model.name ?? ""}`);
			}
		}
		return;
	}

	if (command === "usage" || command === "tokens") {
		const turns = await collectAllTurns(values.profile);
		const stats = aggregateTokens(turns);

		if (values.json) {
			if (values.daily) console.log(JSON.stringify(stats.today, null, 2));
			else if (values.weekly) console.log(JSON.stringify(stats.thisWeek, null, 2));
			else if (values.monthly) console.log(JSON.stringify(stats.thisMonth, null, 2));
			else console.log(JSON.stringify(stats, null, 2));
			return;
		}

		if (values.daily) {
			console.log(renderPeriodTable(stats.today));
		} else if (values.weekly) {
			console.log(renderPeriodTable(stats.thisWeek));
		} else if (values.monthly) {
			console.log(renderPeriodTable(stats.thisMonth));
		} else {
			console.log(renderStatsTable(stats));
		}
		return;
	}

	if (command === "run") {
		if (!values.prompt) throw new Error("usage: agy-multi run --prompt <text>");
		await ensureAgy();
		try {
			const skills = values.skills
				? values.skills
						.split(",")
						.map(s => s.trim())
						.filter(Boolean)
				: undefined;

			const report = await runWithFailover({
				prompt: values.prompt,
				conversationId: values.conversation,
				model: values.model,
				cwd: values.cwd,
				maxSwitches: values["max-switches"] ? Number(values["max-switches"]) : undefined,
				onlyProfile: values.profile,
				switchDelayMs: values["switch-delay"]
					? Math.round(Number(values["switch-delay"]) * 1000)
					: 20_000,
				clean: Boolean(values.clean || values["no-skills"]),
				systemPrompt: values["system-prompt"],
				appendSystemPrompt: values["append-system-prompt"],
				skills,
			});
			if (values.json) {
				console.log(
					JSON.stringify(
						{
							profile: report.profile.slug,
							kind: report.kind,
							switched: report.switched,
							attempts: report.attempts,
							result: report.outcome.result,
						},
						null,
						2,
					),
				);
			} else {
				console.log(report.outcome.result?.response ?? "");
			}
		} catch (error) {
			if (error instanceof RunFailure) {
				console.error(`run failed on ${error.profile.slug}: ${error.kind}`);
				const detail = error.outcome.stderr.trim() || error.outcome.stdout.trim();
				if (detail) console.error(detail);
				process.exitCode = 1;
				return;
			}
			throw error;
		}
		return;
	}

	if (command === "state") {
		console.log(JSON.stringify(await loadState(), null, 2));
		return;
	}

	console.log(HELP);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
