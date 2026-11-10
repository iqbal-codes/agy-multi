import { lstat, realpath, rename, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AGY_BIN, profileDir, profileHome } from "./paths";
import type { Profile } from "./types";
import { ensureDir, exists, linkOrReplaceWithSymlink, run, symlinkIfMissing } from "./fs-utils";
import { listProfiles, loadProfile, profileEnvOf, saveProfile } from "./registry";
import { classifyRun } from "./classify";
import { runTurn } from "./runner";

/** Config that should be identical across accounts and always shared from primary user home. */
const SHARED_ENTRIES = [
	".gemini/config",
	".gemini/skills",
	".gemini/GEMINI.md",
	".gemini/settings.json",
	".gemini/mcp-server-enablement.json",
	".gemini/antigravity-cli/settings.json",
	".gemini/antigravity-cli/keybindings.json",
	".gemini/antigravity-cli/skills",
	".gemini/antigravity-cli/builtin",
	".gemini/antigravity-cli/mcp",
];

/**
 * Tool config that child processes spawned by agy need. Without these, git,
 * gh, npm and ssh silently lose their credentials because HOME changed.
 */
const TOOL_ENTRIES = [".gitconfig", ".config", ".ssh", ".npmrc", ".netrc", ".agents", ".aws", ".kube", ".docker"];

/**
 * A fake HOME has no login keychain, so macOS pops
 * "A keychain cannot be found to store ...". Create an isolated keychain in
 * the profile HOME with no timeout and no auto-lock.
 *
 * NOTE:
 * - We do NOT set default-keychain -s because that changes the user's desktop session default.
 * - We do NOT use -u on unlock-keychain because -u triggers a GUI prompt.
 * - We run set-keychain-settings without flags so macOS never locks it after 300s or on sleep.
 */
async function ensureKeychain(home: string): Promise<void> {
	if (process.platform !== "darwin") return;
	const loginKeychain = join(home, "Library/Keychains/login.keychain-db");
	const keychain = join(home, "Library/Keychains/agy-multi.keychain-db");
	await ensureDir(join(home, "Library/Keychains"));
	if (await exists(loginKeychain)) {
		const stat = await lstat(loginKeychain);
		if (stat.isSymbolicLink()) {
			if (await realpath(loginKeychain) !== await realpath(keychain)) {
				throw new Error(`unexpected keychain link: ${loginKeychain}`);
			}
		} else {
			if (await exists(keychain)) throw new Error(`conflicting profile keychains in ${home}`);
			// macOS treats files named login.keychain-db specially during unlock.
			// Move the database intact; retain the HOME path expected by the official CLI.
			await rename(loginKeychain, keychain);
		}
	}
	if (!(await exists(loginKeychain)) && await exists(keychain)) {
		await symlink("agy-multi.keychain-db", loginKeychain);
	}
	async function security(command: string, ...args: string[]): Promise<void> {
		const result = await run(["/usr/bin/security", command, ...args, keychain], { env: profileEnvOf(home) });
		if (result.exitCode !== 0) {
			throw new Error(`security ${command} failed for ${keychain} (exit ${result.exitCode}): ${result.stderr.trim()}`);
		}
	}
	if (!(await exists(keychain))) {
		await security("create-keychain", "-p", "");
	}
	// Changing settings on a locked keychain prompts before the later unlock can run.
	await security("unlock-keychain", "-p", "");
	await security("set-keychain-settings");
	if (!(await exists(loginKeychain))) {
		await symlink("agy-multi.keychain-db", loginKeychain);
	}
}

/**
 * Check whether a profile has valid credentials without invoking interactive browser popups.
 * On macOS, checks for `antigravity-oauth-token` file, or verifies that the item exists
 * in the isolated keychain without querying plaintext password (no `-w`), which avoids macOS GUI prompts.
 */
export async function hasValidAuth(profile: Profile): Promise<boolean> {
	if (profile.home) return true; // Adopted profile uses system-wide credentials
	const home = profileHome(profile.slug);
	const tokenFile = join(home, ".gemini/antigravity-cli/antigravity-oauth-token");
	if (await exists(tokenFile)) return true;

	if (process.platform === "darwin") {
		const keychain = join(home, "Library/Keychains/login.keychain-db");
		if (!(await exists(keychain))) return false;

		// Check if token exists in keychain WITHOUT -w flag (avoids SecurityAgent GUI prompt)
		const findRes = await run(
			["/usr/bin/security", "find-generic-password", "-s", "gemini", "-a", "antigravity", keychain],
			{ env: profileEnvOf(home) },
		);
		return findRes.exitCode === 0;
	}
	return false;
}

async function provisionShellBridge(home: string, sourceHome: string): Promise<void> {
	if (process.platform === "win32") return;
	const files = [
		{ name: ".zshenv", target: ".zshenv" },
		{ name: ".zprofile", target: ".zprofile" },
		{ name: ".zshrc", target: ".zshrc" },
		{ name: ".bashrc", target: ".bashrc" },
		{ name: ".profile", target: ".profile" },
	];
	for (const { name, target } of files) {
		const filePath = join(home, name);
		const content = [
			`# agy-multi: restore real user HOME for child shells`,
			`export REAL_HOME="${sourceHome}"`,
			`export HOME="$REAL_HOME"`,
			`[ -f "$REAL_HOME/${target}" ] && . "$REAL_HOME/${target}"`,
			"",
		].join("\n");
		await Bun.write(filePath, content);
	}
}

async function provision(home: string, clean = false): Promise<void> {
	await ensureDir(join(home, ".gemini/antigravity-cli"));
	await ensureKeychain(home);
	const sourceHome = process.env.REAL_HOME || homedir();
	if (!clean) {
		for (const rel of SHARED_ENTRIES) {
			const src = join(sourceHome, rel);
			if (rel.endsWith("/skills") || rel.endsWith("/mcp")) {
				await ensureDir(src);
			}
			await linkOrReplaceWithSymlink(join(home, rel), src);
		}
		for (const rel of TOOL_ENTRIES) {
			await symlinkIfMissing(join(home, rel), join(sourceHome, rel));
		}
	} else {
		for (const rel of TOOL_ENTRIES) {
			await symlinkIfMissing(join(home, rel), join(sourceHome, rel));
		}
	}
	await provisionShellBridge(home, sourceHome);
}

function readEmailFromLog(text: string): string | undefined {
	const matches = [...text.matchAll(/applyAuthResult: email=([^\s,]+)/g)];
	return matches.length ? matches[matches.length - 1]![1] : undefined;
}

export interface AddProfileOptions {
	/** Adopt an existing HOME instead of creating an isolated one. */
	home?: string;
	/** Skip the interactive Google login (default: run it). */
	login?: boolean;
	/** Run a generation canary to detect a banned account (default: yes). */
	canary?: boolean;
	/** Print terminal OAuth link instead of opening default browser (ideal for remote/SSH). */
	remote?: boolean;
	/** Provision clean environment without global skills, rules, or MCP servers. */
	clean?: boolean;
}

export async function addProfile(slug: string, opts: AddProfileOptions = {}): Promise<Profile> {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
		throw new Error(`invalid profile slug: ${slug} (use lowercase letters, digits, dashes)`);
	}
	if (await loadProfile(slug)) throw new Error(`profile already exists: ${slug}`);

	const adopted = Boolean(opts.home);
	const home = opts.home ? resolve(opts.home) : profileHome(slug);
	if (adopted && !(await exists(home))) throw new Error(`home does not exist: ${home}`);
	await ensureDir(home);

	const profile: Profile = {
		slug,
		createdAt: new Date().toISOString(),
		...(adopted ? { home } : {}),
		...(opts.clean ? { clean: true } : {}),
	};

	if (!adopted) await provision(home, Boolean(opts.clean));
	await ensureDir(profileDir(slug));

	if (opts.login !== false) {
		const logPath = join(profileDir(slug), "login.log");
		const env = profileEnvOf(home);
		if (opts.remote) {
			env.BROWSER = "/usr/bin/false";
		}
		const exitCode = await Bun.spawn([AGY_BIN, "acp", "--login", "--log-file", logPath], {
			env,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		}).exited;
		if (exitCode !== 0) throw new Error(`login exited with code ${exitCode}; see ${logPath}`);
		const logText = await Bun.file(logPath)
			.text()
			.catch(() => "");
		const email = readEmailFromLog(logText);
		if (!email) throw new Error(`login did not record an account email; see ${logPath}`);
		profile.email = email;
		profile.lastLoginAt = new Date().toISOString();
	}

	if (opts.canary !== false) {
		console.log("Verifying account health (running canary test, ~15-30s)...");
		const outcome = await runTurn(profile, {
			prompt: "Reply with exactly OK.",
			logPath: join(profileDir(slug), "canary.log"),
		});
		const kind = classifyRun(outcome.result?.status, outcome.stdout, outcome.stderr);
		if (kind === "ok") {
			profile.lastGenerationOkAt = new Date().toISOString();
			console.log("Canary check passed: account is healthy and ready.");
		}
		if (kind === "banned") {
			profile.bannedAt = new Date().toISOString();
			profile.bannedReason = "violation of Terms of Service";
			console.error("Warning: Account failed canary check (Terms of Service violation detected).");
		}
		if (kind === "auth") {
			profile.authRequiredAt = new Date().toISOString();
			console.error("Warning: Account requires re-authentication.");
		}
	}

	await saveProfile(profile);
	return profile;
}

/**
 * Re-authenticate an existing profile, resetting any corrupted keychains and saving token to file.
 */
export async function loginProfile(
	slug: string,
	opts: { remote?: boolean; canary?: boolean } = {},
): Promise<Profile> {
	const profile = await loadProfile(slug);
	if (!profile) throw new Error(`profile not found: ${slug}`);

	const home = profile.home ?? profileHome(slug);
	const adopted = Boolean(profile.home);

	if (!adopted && process.platform === "darwin") {
		// Clean up old locked keychain if any
		const keychain = join(home, "Library/Keychains/login.keychain-db");
		await rm(keychain, { force: true });
		await rm(join(home, "Library/Keychains/agy-multi.keychain-db"), { force: true });
		await ensureKeychain(home);
	}

	const logPath = join(profileDir(slug), "login.log");
	const env = profileEnvOf(home);
	if (opts.remote) {
		env.BROWSER = "/usr/bin/false";
	}
	const exitCode = await Bun.spawn([AGY_BIN, "acp", "--login", "--log-file", logPath], {
		env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	}).exited;
	if (exitCode !== 0) throw new Error(`login exited with code ${exitCode}; see ${logPath}`);
	const logText = await Bun.file(logPath)
		.text()
		.catch(() => "");
	const email = readEmailFromLog(logText);
	if (!email) throw new Error(`login did not record an account email; see ${logPath}`);

	profile.email = email;
	profile.lastLoginAt = new Date().toISOString();
	delete profile.authRequiredAt;

	if (opts.canary !== false) {
		console.log("Verifying account health (running canary test, ~15-30s)...");
		const outcome = await runTurn(profile, {
			prompt: "Reply with exactly OK.",
			logPath: join(profileDir(slug), "canary.log"),
		});
		const kind = classifyRun(outcome.result?.status, outcome.stdout, outcome.stderr);
		if (kind === "ok") {
			profile.lastGenerationOkAt = new Date().toISOString();
			console.log("Canary check passed: account is healthy and ready.");
		} else if (kind === "auth") {
			profile.authRequiredAt = new Date().toISOString();
			console.error("Warning: Account still requires re-authentication.");
		}
	}

	await saveProfile(profile);
	return profile;
}

/** Resync all shared config, skills, and tools into an isolated profile HOME. */
export async function syncProfile(slug: string): Promise<boolean> {
	const profile = await loadProfile(slug);
	if (!profile || profile.home) return false;
	await provision(profileHome(slug));
	return true;
}

/** Resync all registered isolated profiles. */
export async function syncProfiles(): Promise<string[]> {
	const profiles = await listProfiles();
	const synced: string[] = [];
	for (const p of profiles) {
		if (p.home) continue;
		await provision(profileHome(p.slug));
		synced.push(p.slug);
	}
	return synced;
}

/** Temporarily disable a profile from candidate selection and failover. */
export async function disableProfile(slug: string): Promise<Profile> {
	const profile = await loadProfile(slug);
	if (!profile) throw new Error(`profile does not exist: ${slug}`);
	profile.disabled = true;
	profile.disabledAt = new Date().toISOString();
	await saveProfile(profile);
	return profile;
}

/** Re-enable a disabled profile. */
export async function enableProfile(slug: string): Promise<Profile> {
	const profile = await loadProfile(slug);
	if (!profile) throw new Error(`profile does not exist: ${slug}`);
	delete profile.disabled;
	delete profile.disabledAt;
	await saveProfile(profile);
	return profile;
}
