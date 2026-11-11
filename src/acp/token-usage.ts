import { existsSync, openSync, readSync, readFileSync, statSync, closeSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_COMPACTION_THRESHOLD = 300_000;

export interface TokenUsageResult {
	usedTokens: number;
	inputTokens?: number;
	cacheReadTokens?: number;
	outputTokens?: number;
}

/**
 * Reads the latest token usage numbers from a session transcript file.
 * Scans backwards in 64KiB blocks, carrying incomplete lines across blocks.
 * Context may decrease after a checkpoint; do not sum usage across steps.
 */
export function readLatestTokenUsage(filePath: string): TokenUsageResult | null {
	try {
		if (!existsSync(filePath)) return null;
		const stat = statSync(filePath);
		if (stat.size === 0) return null;

		const fd = openSync(filePath, "r");
		try {
			let position = stat.size;
			let carry = Buffer.alloc(0);
			while (position > 0) {
				const size = Math.min(position, 65536);
				position -= size;
				const block = Buffer.alloc(size);
				const count = readSync(fd, block, 0, size, position);
				const data = Buffer.concat([block.subarray(0, count), carry]);
				let end = data.length;
				for (let index = data.length - 1; index >= -1; index--) {
					if (index >= 0 && data[index] !== 10) continue;
					if (index === -1 && position > 0) break;
					const line = data.subarray(index + 1, end).toString("utf8");
					end = index;
					if (!line.trim()) continue;
					let item;
					try { item = JSON.parse(line); } catch { continue; } // A writer may have an unfinished final row.
					if (!item || !Number.isFinite(item.input_tokens) || item.input_tokens < 0) continue;
					const inputTokens = item.input_tokens;
					const cacheReadTokens = Number.isFinite(item.cache_read_tokens) && item.cache_read_tokens >= 0 ? item.cache_read_tokens : 0;
					const outputTokens = Number.isFinite(item.output_tokens) && item.output_tokens >= 0 ? item.output_tokens : 0;
					return { usedTokens: inputTokens + cacheReadTokens + outputTokens, inputTokens, cacheReadTokens, outputTokens };
				}
				carry = data.subarray(0, Math.max(0, end));
			}
		} finally {
			closeSync(fd);
		}
	} catch {
		// Ignore any fs or parsing errors
	}
	return null;
}

/**
 * Searches common locations where Antigravity stores conversation transcripts.
 */
export function findSessionTranscript(profileHomeDir: string, childSessionId: string): string | null {
	const candidateHomes = [profileHomeDir];
	if (process.env.HOME && process.env.HOME !== profileHomeDir) {
		candidateHomes.push(process.env.HOME);
	}
	for (const home of candidateHomes) {
		const candidatePaths = [
			join(home, ".gemini", "antigravity-cli", "brain", childSessionId, ".system_generated", "logs", "transcript.jsonl"),
			join(home, ".gemini", "brain", childSessionId, ".system_generated", "logs", "transcript.jsonl"),
			join(home, "brain", childSessionId, ".system_generated", "logs", "transcript.jsonl"),
		];
		for (const path of candidatePaths) {
			if (existsSync(path)) return path;
		}
	}
	return null;
}

/** Transcript usage is unavailable when there is no complete token-bearing row. */
export function resolveSessionTokenUsage(
	profileHomeDir: string | undefined,
	childSessionId: string,
): TokenUsageResult | null {
	if (!profileHomeDir) return null;
	const transcript = findSessionTranscript(profileHomeDir, childSessionId);
	return transcript ? readLatestTokenUsage(transcript) : null;
}

/**
 * Resolves the token threshold for auto-compaction.
 * Precedence:
 * 1. Explicit option passed via code or CLI flag (--compaction-threshold)
 * 2. AGY_COMPACTION_THRESHOLD or AGY_MULTI_COMPACTION_THRESHOLD environment variable
 * 3. compactionThreshold or compaction_threshold in settings.json
 * 4. DEFAULT_COMPACTION_THRESHOLD (300,000 tokens)
 * Set to 0 to disable auto-compaction.
 */
export function resolveCompactionThreshold(
	optionValue?: number,
	env: Record<string, string | undefined> = process.env,
	homeDir: string = process.env.HOME ?? "",
): number {
	if (typeof optionValue === "number" && Number.isFinite(optionValue) && optionValue >= 0) {
		return optionValue;
	}
	const envVal = env.AGY_COMPACTION_THRESHOLD ?? env.AGY_MULTI_COMPACTION_THRESHOLD;
	if (envVal !== undefined && envVal.trim() !== "") {
		const parsed = Number.parseInt(envVal.trim(), 10);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	if (homeDir) {
		const candidateSettingsPaths = [
			join(homeDir, ".gemini", "antigravity-cli", "settings.json"),
			join(homeDir, ".gemini", "settings.json"),
		];
		for (const settingsPath of candidateSettingsPaths) {
			try {
				if (existsSync(settingsPath)) {
					const text = readFileSync(settingsPath, "utf8");
					const parsed = JSON.parse(text);
					if (parsed && typeof parsed === "object") {
						const threshold = parsed.compactionThreshold ?? parsed.compaction_threshold;
						if (typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 0) {
							return threshold;
						}
					}
				}
			} catch {
				// Ignore file read or parse error
			}
		}
	}
	return DEFAULT_COMPACTION_THRESHOLD;
}

/**
 * Extracts --compaction-threshold from argv and returns remaining args.
 */
export function extractCompactionThresholdArg(args: string[]): {
	threshold?: number;
	remainingArgs: string[];
} {
	let threshold: number | undefined;
	const remainingArgs: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--compaction-threshold" && i + 1 < args.length) {
			const parsed = Number.parseInt(args[++i], 10);
			if (Number.isFinite(parsed) && parsed >= 0) threshold = parsed;
		} else if (arg.startsWith("--compaction-threshold=")) {
			const val = arg.slice("--compaction-threshold=".length);
			const parsed = Number.parseInt(val, 10);
			if (Number.isFinite(parsed) && parsed >= 0) threshold = parsed;
		} else {
			remainingArgs.push(arg);
		}
	}
	return { threshold, remainingArgs };
}
