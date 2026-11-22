import { readdir, rm } from "node:fs/promises";
import { profileDir, profileHome, profileMetaPath, profilesDir } from "./paths";
import type { Profile } from "./types";
import { exists, readJson, writeJsonAtomic } from "./fs-utils";

/** The HOME a profile actually runs with. */
export function profileHomeOf(profile: Profile): string {
	return profile.home ?? profileHome(profile.slug);
}

/**
 * Unreachable D-Bus socket used on Linux to isolate managed profiles from the
 * desktop session's shared Secret Service (GNOME Keyring / KWallet).
 * Merely unsetting `DBUS_SESSION_BUS_ADDRESS` is not enough because godbus
 * falls back to `$XDG_RUNTIME_DIR/bus`, causing every profile to share one
 * keyring entry and delete per-profile `antigravity-oauth-token` files.
 */
export const ISOLATED_LINUX_DBUS_ADDRESS = "unix:path=/nonexistent";

/**
 * Cross-platform environment variables for a profile.
 * On Unix (macOS/Linux), sets HOME.
 * On Linux, managed (non-adopted) profiles are also isolated from the desktop
 * D-Bus Secret Service so `agy` stores each account's token in its own
 * `$HOME/.gemini/antigravity-cli/antigravity-oauth-token` file instead of
 * overwriting a single shared GNOME Keyring / KWallet entry.
 * On Windows, sets USERPROFILE, HOMEPATH, and HOMEDRIVE in addition to HOME,
 * which Go's os.UserHomeDir() requires to resolve the isolated home directory.
 */
export function profileEnvOf(
	target: Profile | string,
	baseEnv: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
	const home = typeof target === "string" ? target : profileHomeOf(target);
	const isolated = typeof target === "string" || !target.home;
	const env: Record<string, string | undefined> = {
		...baseEnv,
		HOME: home,
	};
	if (platform === "linux" && isolated) {
		const originalDbus = baseEnv.DBUS_SESSION_BUS_ADDRESS;
		if (originalDbus && originalDbus !== ISOLATED_LINUX_DBUS_ADDRESS && !env.REAL_DBUS_SESSION_BUS_ADDRESS) {
			env.REAL_DBUS_SESSION_BUS_ADDRESS = originalDbus;
		}
		env.DBUS_SESSION_BUS_ADDRESS = ISOLATED_LINUX_DBUS_ADDRESS;
		delete env.GNOME_KEYRING_CONTROL;
	}
	if (platform === "win32") {
		env.USERPROFILE = home;
		env.HOMEPATH = home;
		if (/^[a-zA-Z]:/.test(home)) {
			env.HOMEDRIVE = home.slice(0, 2);
		}
	}
	return env;
}

export async function loadProfile(slug: string): Promise<Profile | null> {
	const path = profileMetaPath(slug);
	if (!(await exists(path))) return null;
	return readJson<Profile | null>(path, null);
}

export async function saveProfile(profile: Profile): Promise<void> {
	await writeJsonAtomic(profileMetaPath(profile.slug), profile);
}

export async function listProfiles(): Promise<Profile[]> {
	let entries: string[];
	try {
		entries = await readdir(profilesDir());
	} catch {
		return [];
	}
	const profiles: Profile[] = [];
	for (const slug of entries.sort()) {
		if (slug.startsWith(".")) continue;
		const profile = await loadProfile(slug);
		if (profile) profiles.push(profile);
	}
	return profiles;
}

export async function removeProfile(slug: string): Promise<void> {
	await rm(profileDir(slug), { recursive: true, force: true });
}
