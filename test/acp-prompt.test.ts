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

	test("handoff includes history, cwd, git head and the last user turn", () => {
		const text = buildHandoffPrompt({
			history: [
				{ role: "user", text: "fix the bug" },
				{ role: "assistant", text: "I found it" },
				{ role: "user", text: "continue" },
			],
			cwd: "/repo",
			gitHead: "abc123",
		});
		expect(text).toContain("Working directory: /repo");
		expect(text).toContain("Git HEAD: abc123");
		expect(text).toContain("User:\nfix the bug");
		expect(text).toContain("Assistant:\nI found it");
		expect(text).toContain("User:\ncontinue");
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
