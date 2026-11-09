import { readdir, rm } from "node:fs/promises";
import { PROFILES_DIR, profileDir, profileHome, profileMetaPath } from "./paths";
import type { Profile } from "./types";
import { exists, readJson, writeJsonAtomic } from "./fs-utils";

/** The HOME a profile actually runs with. */
export function profileHomeOf(profile: Profile): string {
	return profile.home ?? profileHome(profile.slug);
}

/**
 * Cross-platform environment variables for a profile.
 * On Unix (macOS/Linux), sets HOME.
 * On Windows, sets USERPROFILE, HOMEPATH, and HOMEDRIVE in addition to HOME,
 * which Go's os.UserHomeDir() requires to resolve the isolated home directory.
 */
export function profileEnvOf(
	target: Profile | string,
	baseEnv: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
	const home = typeof target === "string" ? target : profileHomeOf(target);
	const env: Record<string, string | undefined> = {
		...baseEnv,
		HOME: home,
	};
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
		entries = await readdir(PROFILES_DIR);
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
