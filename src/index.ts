#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { runAcpProxy } from "./acp/server";
import { extractCompactionThresholdArg } from "./acp/token-usage";
import { ensureAgy } from "./setup";
import { addProfile, disableProfile, enableProfile, loginProfile, syncProfile, syncProfiles } from "./profile";
import { listProfiles, removeProfile } from "./registry";
import { runWithFailover, RunFailure } from "./runner";
import { loadState } from "./state";
import { fetchUsage } from "./usage";
import { fetchModels, readCachedModels } from "./models";
import { MODELS_TTL_MS } from "./paths";
import { aggregateTokens, collectAllTurns, renderPeriodTable, renderStatsTable } from "./analytics";

const HELP = `agy-multi — run the official agy CLI across multiple isolated accounts

Usage:
  agy-multi profile add <slug> [--home <dir>] [--remote] [--no-login] [--no-canary] [--clean]
  agy-multi profile login <slug> [--remote] [--no-canary]
  agy-multi profile list
  agy-multi profile disable <slug>
  agy-multi profile enable <slug>
  agy-multi profile sync [<slug>]
  agy-multi profile remove <slug>
  agy-multi quota [--profile <slug>]
  agy-multi models [--profile <slug>] [--refresh]
  agy-multi usage [--daily | --weekly | --monthly] [--profile <slug>] [--json]
  agy-multi acp [--clean] [--compaction-threshold <tokens>] [-- agy acp args...]
  agy-multi run --prompt <text> [--clean] [--no-skills] [--skills <list>]
                 [--system-prompt <text|file>] [--append-system-prompt <text|file>]
                 [--conversation <id>] [--model <id>] [--profile <slug>]
                 [--max-switches <n>] [--cwd <dir>] [--json]
  agy-multi state

ACP Options:
  --clean                        Bypasses default skills, plugins, rules bloat and slash commands.
  --compaction-threshold <tokens> Auto-compacts conversation when context reaches this limit (default: 300000, 0 to disable).

Subagent Clean Mode & Manual Injections (ala Pi Agent):
  --clean / --no-skills          Bypasses default skills, plugins, rules bloat and slash commands.
  --skills <list>                Comma-separated skill names or directories to inject.
  --system-prompt <text|file>    Custom system prompt (text or file path).
  --append-system-prompt <file>  Additional instructions appended to prompt.

Each profile is a separate HOME; the official agy binary and its OAuth client
are never modified. Failover is handoff-only: a conversation is never replayed
under a different account.
`;

async function main(): Promise<void> {
	const rawArgs = Bun.argv.slice(2);
	if (rawArgs[0] === "acp" && rawArgs[1] !== "--help" && rawArgs[1] !== "-h") {
		await ensureAgy({ autoInstall: true });
		const clean = rawArgs.includes("--clean");
		const filteredArgs = rawArgs.slice(1).filter((arg: string) => arg !== "--" && arg !== "--clean");
		const { threshold, remainingArgs } = extractCompactionThresholdArg(filteredArgs);
		const extraArgs = clean
			? ["--include-default-customizations=false", "--disable-slash-commands", ...remainingArgs]
			: remainingArgs;
		await runAcpProxy({ compactionThreshold: threshold, extraArgs });
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
			help: { type: "boolean", short: "h" },
		},
	});

	const [command, subcommand, ...rest] = positionals;
	if (!command || values.help) {
		console.log(HELP);
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
		await ensureAgy();
		const profiles = (await listProfiles()).filter(p => !values.profile || p.slug === values.profile);
		if (!profiles.length) {
			console.log("no profiles");
			return;
		}
		for (const profile of profiles) {
			const snapshot = await fetchUsage(profile).catch(() => null);
			if (!snapshot) {
				console.log(`${profile.slug}\t(unavailable)`);
				continue;
			}
			for (const window of snapshot.windows) {
				console.log(
					`${profile.slug}\t${window.family}\t${window.window}\t${window.remainingPct}%\t${window.resetsAt}`,
				);
			}
		}
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
