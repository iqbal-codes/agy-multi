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

export interface ProfileUsageEntry {
	profile: Profile;
	snapshot: UsageSnapshot | null;
}

export interface WindowAverage {
	fiveHour?: number;
	weekly?: number;
	fiveHourResetsAt?: string;
	weeklyResetsAt?: string;
	count: number;
}

export interface AccountUsageRow {
	slug: string;
	email?: string;
	status: "active" | "disabled" | "banned" | "auth-required" | "unavailable";
	gemini: { fiveHour?: number; weekly?: number };
	claudeGpt: { fiveHour?: number; weekly?: number };
}

export interface MultiUsageSummary {
	totalAccounts: number;
	measuredAccounts: number;
	gemini: WindowAverage;
	claudeGpt: WindowAverage;
	overall: { fiveHour?: number; weekly?: number };
	accounts: AccountUsageRow[];
}

function mean(values: number[]): number | undefined {
	if (!values.length) return undefined;
	return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function formatPct(value: number | undefined): string {
	if (value === undefined) return "—";
	const rounded = Math.round(value * 10) / 10;
	return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function accountStatus(profile: Profile, snapshot: UsageSnapshot | null): AccountUsageRow["status"] {
	if (profile.disabled) return "disabled";
	if (profile.bannedAt) return "banned";
	if (profile.authRequiredAt) return "auth-required";
	return snapshot ? "active" : "unavailable";
}

function earliestReset(resets: Array<string | undefined>): string | undefined {
	let bestMs = Number.POSITIVE_INFINITY;
	let bestIso: string | undefined;
	for (const iso of resets) {
		if (!iso) continue;
		const ms = Date.parse(iso);
		if (Number.isFinite(ms) && ms < bestMs) {
			bestMs = ms;
			bestIso = iso;
		}
	}
	return bestIso;
}

function windowResetIso(snapshot: UsageSnapshot | null, family: Family, windowId: WindowId): string | undefined {
	return snapshot?.windows.find(w => w.family === family && w.window === windowId)?.resetsAt;
}

/** Compute per-account and average 5-hour / weekly quota remaining across profiles. */
export function summarizeMultiUsage(entries: ProfileUsageEntry[]): MultiUsageSummary {
	const gemini5h: number[] = [];
	const geminiWeekly: number[] = [];
	const claude5h: number[] = [];
	const claudeWeekly: number[] = [];
	const gemini5hResets: Array<string | undefined> = [];
	const geminiWeeklyResets: Array<string | undefined> = [];
	const claude5hResets: Array<string | undefined> = [];
	const claudeWeeklyResets: Array<string | undefined> = [];
	const all5h: number[] = [];
	const allWeekly: number[] = [];
	let measuredAccounts = 0;

	const accounts: AccountUsageRow[] = entries.map(({ profile, snapshot }) => {
		const status = accountStatus(profile, snapshot);
		const g5 = windowRemaining(snapshot, "gemini", "fiveHour");
		const gw = windowRemaining(snapshot, "gemini", "weekly");
		const c5 = windowRemaining(snapshot, "claude-gpt", "fiveHour");
		const cw = windowRemaining(snapshot, "claude-gpt", "weekly");
		const hasAny = g5 !== undefined || gw !== undefined || c5 !== undefined || cw !== undefined;
		if (status === "active" && hasAny) {
			measuredAccounts++;
			if (g5 !== undefined) {
				gemini5h.push(g5);
				all5h.push(g5);
				gemini5hResets.push(windowResetIso(snapshot, "gemini", "fiveHour"));
			}
			if (gw !== undefined) {
				geminiWeekly.push(gw);
				allWeekly.push(gw);
				geminiWeeklyResets.push(windowResetIso(snapshot, "gemini", "weekly"));
			}
			if (c5 !== undefined) {
				claude5h.push(c5);
				all5h.push(c5);
				claude5hResets.push(windowResetIso(snapshot, "claude-gpt", "fiveHour"));
			}
			if (cw !== undefined) {
				claudeWeekly.push(cw);
				allWeekly.push(cw);
				claudeWeeklyResets.push(windowResetIso(snapshot, "claude-gpt", "weekly"));
			}
		}
		return {
			slug: profile.slug,
			email: profile.email,
			status,
			gemini: { fiveHour: g5, weekly: gw },
			claudeGpt: { fiveHour: c5, weekly: cw },
		};
	});

	return {
		totalAccounts: entries.length,
		measuredAccounts,
		gemini: {
			fiveHour: mean(gemini5h),
			weekly: mean(geminiWeekly),
			fiveHourResetsAt: earliestReset(gemini5hResets),
			weeklyResetsAt: earliestReset(geminiWeeklyResets),
			count: Math.max(gemini5h.length, geminiWeekly.length),
		},
		claudeGpt: {
			fiveHour: mean(claude5h),
			weekly: mean(claudeWeekly),
			fiveHourResetsAt: earliestReset(claude5hResets),
			weeklyResetsAt: earliestReset(claudeWeeklyResets),
			count: Math.max(claude5h.length, claudeWeekly.length),
		},
		overall: {
			fiveHour: mean(all5h),
			weekly: mean(allWeekly),
		},
		accounts,
	};
}

/** Format averaged 5-hour & weekly quota limits in standard Antigravity `/usage` TSV format. */
export function formatMultiUsageReport(entries: ProfileUsageEntry[]): string {
	if (!entries.length) return "No accounts configured.";
	const summary = summarizeMultiUsage(entries);
	const rows: Array<[string, string, number | undefined, string | undefined]> = [
		["Gemini Models", "Weekly Limit Remaining", summary.gemini.weekly, summary.gemini.weeklyResetsAt],
		["Gemini Models", "Five Hour Limit Remaining", summary.gemini.fiveHour, summary.gemini.fiveHourResetsAt],
		["Claude and GPT models", "Weekly Limit Remaining", summary.claudeGpt.weekly, summary.claudeGpt.weeklyResetsAt],
		[
			"Claude and GPT models",
			"Five Hour Limit Remaining",
			summary.claudeGpt.fiveHour,
			summary.claudeGpt.fiveHourResetsAt,
		],
	];
	const lines = rows
		.filter(([, , pct]) => pct !== undefined)
		.map(([group, label, pct, resetsAt]) => `${group}\t${label}\t${formatPct(pct)}\t${resetsAt ?? "—"}`);
	return lines.length ? lines.join("\n") : "No usage data available.";
}
