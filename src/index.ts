#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { runAcpProxy } from "./acp/server";
import { ensureAgy } from "./setup";
import { addProfile, loginProfile, syncProfile, syncProfiles } from "./profile";
import { listProfiles, removeProfile } from "./registry";
import { runWithFailover, RunFailure } from "./runner";
import { loadState } from "./state";
import { fetchUsage } from "./usage";

const HELP = `agy-multi — run the official agy CLI across multiple isolated accounts

Usage:
  agy-multi profile add <slug> [--home <dir>] [--remote] [--no-login] [--no-canary]
  agy-multi profile login <slug> [--remote] [--no-canary]
  agy-multi profile list
  agy-multi profile sync [<slug>]
  agy-multi profile remove <slug>
  agy-multi usage [--profile <slug>]
  agy-multi acp [-- agy acp args...]
  agy-multi run --prompt <text> [--conversation <id>] [--model <id>]
                 [--profile <slug>] [--max-switches <n>] [--cwd <dir>] [--json]
  agy-multi state

Each profile is a separate HOME; the official agy binary and its OAuth client
are never modified. Failover is handoff-only: a conversation is never replayed
under a different account.
`;

async function main(): Promise<void> {
	const rawArgs = Bun.argv.slice(2);
	if (rawArgs[0] === "acp" && rawArgs[1] !== "--help" && rawArgs[1] !== "-h") {
		await ensureAgy({ autoInstall: true });
		const extraArgs = rawArgs.slice(1).filter((arg: string) => arg !== "--");
		await runAcpProxy({ extraArgs });
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
			if (!slug) throw new Error("usage: agy-multi profile add <slug> [--home <dir>] [--remote] [--no-login] [--no-canary]");
			if (!values["no-login"] || !values["no-canary"]) {
				await ensureAgy();
			}
			const profile = await addProfile(slug, {
				home: values.home,
				login: !values["no-login"],
				canary: !values["no-canary"],
				remote: Boolean(values.remote),
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
				const status = profile.bannedAt
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

	if (command === "usage") {
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

	if (command === "run") {
		if (!values.prompt) throw new Error("usage: agy-multi run --prompt <text>");
		await ensureAgy();
		try {
			const report = await runWithFailover({
				prompt: values.prompt,
				conversationId: values.conversation,
				model: values.model,
				cwd: values.cwd,
				maxSwitches: values["max-switches"] ? Number(values["max-switches"]) : undefined,
				onlyProfile: values.profile,
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
