import { describe, expect, test } from "bun:test";
import { buildHandoffPrompt, promptToText, renderHistory } from "../src/acp/prompt";

describe("ACP prompt helpers", () => {
	test("extracts text, file links and images", () => {
		expect(
			promptToText([
				{ type: "text", text: "hello" },
				{ type: "resource_link", name: "a.ts", uri: "file:///a.ts" },
				{ type: "image", data: "", mimeType: "image/png" },
			]),
		).toBe("hello\n[file: a.ts]\n[image]");
	});

	test("replay is the transcript verbatim, with no framing and no account narrative", () => {
		const text = buildHandoffPrompt({
			history: [
				{ role: "user", text: "fix the bug" },
				{ role: "assistant", text: "I found it" },
				{ role: "user", text: "continue" },
			],
		});
		expect(text).toBe("User:\nfix the bug\n\nAssistant:\nI found it\n\nUser:\ncontinue");
		// Nothing is added to make the new session behave differently.
		expect(text).not.toContain("Conversation so far");
		expect(text).not.toContain("Continue from the last user message");
		expect(text.toLowerCase()).not.toContain("account");
		expect(text).not.toContain("Working directory");
	});

	test("replay defaults to the whole conversation and honours a cap", () => {
		const entries = [
			{ role: "user" as const, text: "old".repeat(100) },
			{ role: "assistant" as const, text: "new".repeat(100) },
		];
		expect(buildHandoffPrompt({ history: entries })).toContain("old".repeat(100));
		const capped = buildHandoffPrompt({ history: entries, maxChars: 250 });
		expect(capped).toContain("earlier turns omitted");
		expect(capped).toContain("new".repeat(100));
		expect(capped).not.toContain("old".repeat(100));
	});

	test("history rendering keeps the most recent turns under the cap", () => {
		const entries = [
			{ role: "user" as const, text: "old".repeat(100) },
			{ role: "assistant" as const, text: "new".repeat(100) },
		];
		const rendered = renderHistory(entries, 250);
		expect(rendered).toContain("earlier turns omitted");
		expect(rendered).toContain("new".repeat(100));
		expect(rendered).not.toContain("old".repeat(100));
	});
});
