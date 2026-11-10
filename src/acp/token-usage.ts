import { existsSync, openSync, readSync, statSync, closeSync } from "node:fs";
import { join } from "node:path";

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
	const candidatePaths = [
		join(profileHomeDir, ".gemini", "antigravity-cli", "brain", childSessionId, ".system_generated", "logs", "transcript.jsonl"),
		join(profileHomeDir, ".gemini", "brain", childSessionId, ".system_generated", "logs", "transcript.jsonl"),
		join(profileHomeDir, "brain", childSessionId, ".system_generated", "logs", "transcript.jsonl"),
	];

	for (const path of candidatePaths) {
		if (existsSync(path)) return path;
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
