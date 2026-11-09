/** Prompt/history helpers shared by ACP session handling and handoff. */

import { isRecord } from "./guards";

export interface HistoryEntry {
	role: "user" | "assistant";
	text: string;
}

/**
 * Flatten an ACP ContentBlock into text suitable for history and handoff.
 * Embedded resources keep their text (the model may need it); links/images
 * become short placeholders so a handoff stays small.
 */
export function contentBlockText(block: unknown): string {
	if (!isRecord(block)) return "";
	const value = block;
	if (value.type === "text" && typeof value.text === "string") return value.text;
	if (value.type === "resource_link") {
		const title =
			typeof value.title === "string" ? value.title : typeof value.name === "string" ? value.name : undefined;
		const uri = typeof value.uri === "string" ? value.uri : undefined;
		return title || uri ? `[file: ${title ?? uri}]` : "";
	}
	if (value.type === "resource" && isRecord(value.resource)) {
		const resource = value.resource;
		if (typeof resource.text === "string" && resource.text) return resource.text;
		return typeof resource.uri === "string" ? `[resource: ${resource.uri}]` : "";
	}
	if (value.type === "image") return "[image]";
	if (value.type === "audio") return "[audio]";
	return "";
}

export function promptToText(prompt: unknown): string {
	if (!Array.isArray(prompt)) return "";
	return prompt
		.map(contentBlockText)
		.filter(part => part.length > 0)
		.join("\n");
}

/**
 * Render the most recent history under a character budget. The newest turns
 * are the ones a handoff needs; older turns are summarized away.
 */
export function renderHistory(entries: HistoryEntry[], maxChars = 60_000): string {
	const blocks: string[] = [];
	let used = 0;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		const text = entry.text.trim();
		if (!text) continue;
		const block = `${entry.role === "user" ? "User" : "Assistant"}:\n${text}`;
		if (blocks.length > 0 && used + block.length > maxChars) {
			blocks.unshift("[earlier turns omitted]");
			break;
		}
		blocks.unshift(block);
		used += block.length;
	}
	return blocks.join("\n\n");
}

export interface HandoffPromptOptions {
	history: HistoryEntry[];
	cwd: string;
	gitHead?: string;
	maxChars?: number;
}

export function buildHandoffPrompt(options: HandoffPromptOptions): string {
	const history = renderHistory(options.history, options.maxChars);
	const lines = [
		"You are taking over an existing coding session on a different account after an account/quota handoff.",
		"The previous account may have used tools; you do not have its in-memory tool state. Verify the workspace before acting.",
		`Working directory: ${options.cwd}`,
	];
	if (options.gitHead) lines.push(`Git HEAD: ${options.gitHead}`);
	lines.push("", "Conversation so far:", history || "(no prior turns)", "");
	lines.push("Continue the task from the last user message. Do not repeat work that is already complete.");
	return lines.join("\n");
}

export function toolTitle(update: unknown): string | undefined {
	if (!isRecord(update)) return undefined;
	for (const key of ["title", "name", "kind"] as const) {
		if (typeof update[key] === "string" && update[key]) return update[key];
	}
	return undefined;
}
