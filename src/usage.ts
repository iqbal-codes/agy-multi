import { join } from "node:path";
import { AGY_BIN, profileDir } from "./paths";
import { profileEnvOf } from "./registry";
import type { Family, Profile, UsageSnapshot, UsageWindow, WindowId } from "./types";
import { readJson, writeJsonAtomic } from "./fs-utils";
import { hasValidAuth } from "./profile";

export function profileUsagePath(slug: string): string {
	return join(profileDir(slug), "usage.json");
}

export async function readCachedUsage(slug: string): Promise<UsageSnapshot | null> {
	return await readJson<UsageSnapshot | null>(profileUsagePath(slug), null);
}

export async function writeCachedUsage(snapshot: UsageSnapshot): Promise<void> {
	await writeJsonAtomic(profileUsagePath(snapshot.profile), snapshot);
}

/** Which backend quota counter a model consumes. */
export function familyForModel(modelId?: string): Family {
	if (!modelId) return "gemini";
	const id = modelId.toLowerCase();
	if (id.startsWith("claude") || id.startsWith("gpt") || id.startsWith("openai/")) return "claude-gpt";
	return "gemini";
}

/**
 * Parse the tab-separated `/usage` table:
 *   Gemini Models\tWeekly Limit Remaining\t99%\t2026-11-15T23:41:21Z
 *   Claude and GPT models\tFive Hour Limit Remaining\t100%\t...
 */
export function parseUsageTable(text: string): UsageWindow[] {
	const windows: UsageWindow[] = [];
	for (const line of text.split(/\r?\n/)) {
		const cols = line.split("\t").map(col => col.trim());
		if (cols.length < 4) continue;
		const [group, label, pctText, resetsAt] = cols;
		const remainingPct = Number.parseFloat(pctText.replace("%", ""));
		if (!Number.isFinite(remainingPct)) continue;
		const family: Family = /gemini/i.test(group) ? "gemini" : "claude-gpt";
		const window: WindowId | undefined = /weekly/i.test(label)
			? "weekly"
			: /five hour/i.test(label)
				? "fiveHour"
				: undefined;
		if (!window) continue;
		windows.push({ family, window, remainingPct, resetsAt });
	}
	return windows;
}

export function minRemaining(snapshot: UsageSnapshot | null, family: Family): number | undefined {
	if (!snapshot) return undefined;
	const values = snapshot.windows.filter(w => w.family === family).map(w => w.remainingPct);
	return values.length ? Math.min(...values) : undefined;
}

export function windowRemaining(
	snapshot: UsageSnapshot | null,
	family: Family,
	windowId: WindowId,
): number | undefined {
	if (!snapshot) return undefined;
	const win = snapshot.windows.find(w => w.family === family && w.window === windowId);
	return win?.remainingPct;
}

export function windowReset(
	snapshot: UsageSnapshot | null,
	family: Family,
	windowId: WindowId,
): number | undefined {
	if (!snapshot) return undefined;
	const win = snapshot.windows.find(w => w.family === family && w.window === windowId);
	if (!win) return undefined;
	const ms = Date.parse(win.resetsAt);
	return Number.isFinite(ms) ? ms : undefined;
}

/** Earliest reset worth waiting for after a quota error. Prefers exhausted windows. */
export function blockingReset(snapshot: UsageSnapshot | null, family: Family, now: number): number | undefined {
	if (!snapshot) return undefined;
	const familyWindows = snapshot.windows.filter(w => w.family === family);
	const exhausted = familyWindows.filter(w => w.remainingPct <= 0);
	const candidates = exhausted.length ? exhausted : familyWindows;
	const resets = candidates
		.map(w => Date.parse(w.resetsAt))
		.filter(ms => Number.isFinite(ms) && ms > now);
	return resets.length ? Math.min(...resets) : undefined;
}

export async function fetchUsage(profile: Profile, timeoutMs = 30_000, signal?: AbortSignal): Promise<UsageSnapshot | null> {
	if (signal?.aborted || profile.authRequiredAt || profile.bannedAt || profile.disabled) return null;
	// Do not run interactive agy usage check if account has no credentials (avoids unexpected browser popups)
	if (!(await hasValidAuth(profile))) {
		return null;
	}
	// Shutdown can happen while the credential-presence check is pending.
	if (signal?.aborted) return null;
	const logPath = join(profileDir(profile.slug), "usage.log");
	const proc = Bun.spawn(
		[AGY_BIN, "-p", "/usage", "--output-format", "json", "--log-file", logPath],
		{
			// Host ACP probes terminate their process group after session/new.
			// Keep that SIGTERM away from the CLI's credential-reader subprocess:
			// the official CLI treats an interrupted read as a request to log in.
			detached: process.platform !== "win32",
			env: {
				...profileEnvOf(profile),
				BROWSER: "/usr/bin/true", // Best effort only: macOS CLI can invoke open directly.
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	let cancelled = false;
	const cancel = () => {
		cancelled = true;
		// SIGTERM can run the CLI's interactive OAuth fallback. Kill the owned
		// process group atomically, including credential readers and MCP children.
		if (process.platform === "win32") {
			proc.kill("SIGKILL");
		} else {
			try {
				process.kill(-proc.pid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
	};
	const timer = setTimeout(cancel, timeoutMs);
	signal?.addEventListener("abort", cancel, { once: true });
	if (signal?.aborted) cancel();
	try {
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;
		if (cancelled || exitCode !== 0) return null;
		if (stderr.trim() && !stdout.trim()) return null;
		let parsed: { status?: string; response?: string };
		try {
			parsed = JSON.parse(stdout);
		} catch {
			return null;
		}
		if (parsed.status !== "SUCCESS" || !parsed.response) return null;
		const snapshot: UsageSnapshot = {
			profile: profile.slug,
			fetchedAt: Date.now(),
			windows: parseUsageTable(parsed.response),
			raw: parsed.response,
		};
		await writeCachedUsage(snapshot).catch(() => {});
		return snapshot;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
	}
}
