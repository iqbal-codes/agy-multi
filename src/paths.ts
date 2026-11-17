import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const DEFAULT_ROOT = join(HOME, ".agy-multi");
const LEGACY_ROOT = join(HOME, ".agy");
const OVERRIDE = process.env.AGY_MULTI_ROOT || undefined;

/** Whether a path holds agy-multi state, rather than some unrelated directory. */
function isOurs(path: string): boolean {
	return existsSync(join(path, "profiles")) || existsSync(join(path, "state.json"));
}

/**
 * Resolves the state root, moving a pre-rename `~/.agy` into `~/.agy-multi` once.
 * The rename is atomic and keeps every profile HOME intact; conversation links
 * are relative, so they survive it. If the move is impossible the legacy root is
 * used as-is rather than losing state.
 */
function resolveRoot(): string {
	if (OVERRIDE) return OVERRIDE;
	if (existsSync(DEFAULT_ROOT) || !isOurs(LEGACY_ROOT)) return DEFAULT_ROOT;
	try {
		renameSync(LEGACY_ROOT, DEFAULT_ROOT);
		process.stderr.write(`agy-multi: moved ${LEGACY_ROOT} to ${DEFAULT_ROOT}\n`);
		return DEFAULT_ROOT;
	} catch (error) {
		process.stderr.write(
			`agy-multi: could not move ${LEGACY_ROOT} to ${DEFAULT_ROOT} (${error instanceof Error ? error.message : String(error)}); using ${LEGACY_ROOT}\n`,
		);
		return LEGACY_ROOT;
	}
}

/** Wrapper state root. Override for tests. */
export const ROOT = resolveRoot();
export const PROFILES_DIR = join(ROOT, "profiles");
export const STATE_PATH = join(ROOT, "state.json");
export const ACP_SESSIONS_PATH = join(ROOT, "acp-sessions.json");
export function resolveAgyBin(): string {
	if (process.env.AGY_BIN) return process.env.AGY_BIN;
	const binName = process.platform === "win32" ? "agy.exe" : "agy";
	const inPath = Bun.which(binName);
	if (inPath) return inPath;

	const home = homedir();
	const candidates: string[] = [];
	if (process.platform === "win32") {
		if (process.env.LOCALAPPDATA) {
			candidates.push(join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe"));
		}
		candidates.push(join(home, ".local", "bin", "agy.exe"));
	} else {
		candidates.push(join(home, ".local", "bin", "agy"));
		candidates.push("/usr/local/bin/agy");
	}

	for (const candidate of candidates) {
		const found = Bun.which(candidate);
		if (found) return found;
	}

	return binName;
}

export function ensureAgyInstalled(): void {
	const bin = resolveAgyBin();
	if (!Bun.which(bin)) {
		const installCmd = process.platform === "win32"
			? "irm https://antigravity.google/cli/install.ps1 | iex"
			: "curl -fsSL https://antigravity.google/cli/install.sh | bash";
		throw new Error(
			`Official Antigravity CLI ('agy') was not found in PATH or standard directories.\nPlease install it first by running:\n\n  ${installCmd}\n`
		);
	}
}

export let AGY_BIN = resolveAgyBin();
export function updateAgyBin(): string {
	AGY_BIN = resolveAgyBin();
	return AGY_BIN;
}

/** Default protected quota percentage. */
export const DEFAULT_RESERVE_PCT = 10;

/** Default block duration when a quota error carries no usable reset. */
export const DEFAULT_BLOCK_MS = 5 * 60 * 60 * 1000;

/** Usage preflight cache TTL (5 minutes). */
export const USAGE_TTL_MS = 5 * 60_000;

/** Model capability cache TTL (12 hours). */
export const MODELS_TTL_MS = 12 * 60 * 60_000;

export function profileDir(slug: string): string {
	const root = process.env.AGY_MULTI_ROOT ?? ROOT;
	return join(root, "profiles", slug);
}

export function profileHome(slug: string): string {
	return join(profileDir(slug), "home");
}

export function profileMetaPath(slug: string): string {
	return join(profileDir(slug), "profile.json");
}
