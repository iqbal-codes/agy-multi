import { existsSync, openSync, readSync, statSync, closeSync } from "node:fs";
import { join } from "node:path";

export interface TokenUsageResult {
	usedTokens: number;
	inputTokens?: number;
	cacheReadTokens?: number;
	outputTokens?: number;
}

/**
 * Returns the context window limit for a given model ID.
 * Gemini models default to 1M (or 2M for pro), Claude to 200k, GPT to 128k.
 */
export function getModelContextSize(modelId?: string): number {
	if (!modelId) return 1_048_576;
	const lower = modelId.toLowerCase();
	if (lower.includes("gemini")) {
		if (lower.includes("pro") || lower.includes("1.5-pro") || lower.includes("2.5-pro")) {
			return 2_097_152;
		}
		return 1_048_576;
	}
	if (lower.includes("claude")) {
		return 200_000;
	}
	if (lower.includes("gpt")) {
		return 128_000;
	}
	return 1_048_576;
}

/**
 * Reads the latest token usage numbers from a session transcript file.
 * Efficiently scans the last 64KB of the file backwards to find the last step
 * with input_tokens.
 */
export function readLatestTokenUsage(filePath: string): TokenUsageResult | null {
	try {
		if (!existsSync(filePath)) return null;
		const stat = statSync(filePath);
		if (stat.size === 0) return null;

		const readSize = Math.min(stat.size, 65536);
		const buffer = Buffer.alloc(readSize);
		const fd = openSync(filePath, "r");
		try {
			readSync(fd, buffer, 0, readSize, stat.size - readSize);
		} finally {
			closeSync(fd);
		}

		const chunk = buffer.toString("utf8");
		const lines = chunk.split("\n").filter(line => line.trim().length > 0);

		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const item = JSON.parse(lines[i]);
				if (typeof item.input_tokens === "number") {
					const inputTokens = item.input_tokens;
					const cacheReadTokens = typeof item.cache_read_tokens === "number" ? item.cache_read_tokens : 0;
					const outputTokens = typeof item.output_tokens === "number" ? item.output_tokens : 0;
					return {
						usedTokens: inputTokens + cacheReadTokens + outputTokens,
						inputTokens,
						cacheReadTokens,
						outputTokens,
					};
				}
			} catch {
				// Partial line at chunk boundary, safe to ignore
			}
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

/**
 * Fallback token estimation based on character count when transcript is not yet available.
 */
export function estimateTokensFromHistory(history: { text: string }[]): number {
	let chars = 0;
	for (const h of history) {
		chars += h.text.length;
	}
	return Math.max(100, Math.round(chars / 3.8));
}

/**
 * Resolves the token usage for a session:
 * 1. Checks transcript file on disk for exact tokens from Google API.
 * 2. Falls back to estimation from history.
 */
export function resolveSessionTokenUsage(
	profileHomeDir: string | undefined,
	childSessionId: string,
	history: { text: string }[],
): number {
	if (profileHomeDir) {
		const transcript = findSessionTranscript(profileHomeDir, childSessionId);
		if (transcript) {
			const usage = readLatestTokenUsage(transcript);
			if (usage) return usage.usedTokens;
		}
	}
	return estimateTokensFromHistory(history);
}
