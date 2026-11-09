import { join } from "node:path";
import { AGY_BIN, profileDir } from "./paths";
import { profileEnvOf, profileHomeOf } from "./registry";
import type { Family, Profile, UsageSnapshot, UsageWindow, WindowId } from "./types";
import { run } from "./fs-utils";
import { hasValidAuth } from "./profile";

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

export async function fetchUsage(profile: Profile, timeoutMs = 30_000): Promise<UsageSnapshot | null> {
	if (profile.authRequiredAt || profile.bannedAt) return null;
	// Do not run interactive agy usage check if account has no credentials (avoids unexpected browser popups)
	if (!(await hasValidAuth(profile))) {
		return null;
	}
	const logPath = join(profileDir(profile.slug), "usage.log");
	const proc = Bun.spawn(
		[AGY_BIN, "-p", "/usage", "--output-format", "json", "--log-file", logPath],
		{
			env: {
				...profileEnvOf(profile),
				BROWSER: "/usr/bin/true", // Safety: never spawn browser tabs during background usage checks
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const timer = setTimeout(() => proc.kill(), timeoutMs);
	try {
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		if (stderr.trim() && !stdout.trim()) return null;
		let parsed: { status?: string; response?: string };
		try {
			parsed = JSON.parse(stdout);
		} catch {
			return null;
		}
		if (parsed.status !== "SUCCESS" || !parsed.response) return null;
		return {
			profile: profile.slug,
			fetchedAt: Date.now(),
			windows: parseUsageTable(parsed.response),
			raw: parsed.response,
		};
	} finally {
		clearTimeout(timer);
	}
}
