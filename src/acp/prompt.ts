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
 * Render history for replay under a character budget. Newest turns are kept; when
 * the budget is exhausted the oldest surviving block is marked as omitted.
 */
export function renderHistory(entries: HistoryEntry[], maxChars = Number.POSITIVE_INFINITY): string {
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
	/** Conversation the client already holds; replayed so the new session starts warm. */
	history: HistoryEntry[];
	/** Character budget for the replay; `0` or `undefined` replays everything. */
	maxChars?: number;
}

/**
 * Seeds a fresh backend session with the conversation the client already has.
 *
 * The replay is the transcript and nothing else: no framing line, no request to
 * continue, no account narrative, no synthesized tool markers. The new session
 * sees the turns the user sees and answers the last user message — the closest a
 * text-only protocol allows to carrying the session across accounts.
 */
export function buildHandoffPrompt(options: HandoffPromptOptions): string {
	const maxChars = options.maxChars && options.maxChars > 0 ? options.maxChars : Number.POSITIVE_INFINITY;
	return renderHistory(options.history, maxChars);
}

