import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ensureGlobalGeminiRules, T3_ACP_RULES } from "../src/profile";

const LEGACY_USER_LINE = "# Custom Instructions\nAlways speak kindly.";
const LEGACY_RULES = `# ACP & Multi-Agent Orchestration Rules

1. **Synchronous Execution & Command Handling (All ACP Clients):**
   - Always set \`WaitMsBeforeAsync: 10000\` (the maximum allowed) to ensure synchronous execution.

2. **Subagents & Multi-Agent Work:**
   - Uses \`T3_ACP_MCP_NODE\`.
   - Execute the task directly within the active thread rather than spawning hidden background subagents, unless the host provides a client-specific delegation tool.
`;

describe("ensureGlobalGeminiRules helper", () => {
	it("creates ~/.gemini/GEMINI.md with rules when file and folder do not exist", async () => {
		const tempHome = join(tmpdir(), `test-gemini-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		try {
			await ensureGlobalGeminiRules(tempHome);
			const targetPath = join(tempHome, ".gemini", "GEMINI.md");
			expect(existsSync(targetPath)).toBe(true);

			const content = readFileSync(targetPath, "utf-8");
			expect(content).toContain("# ACP & Multi-Agent Orchestration Rules");
			expect(content).toContain("T3_ACP_MCP_NODE");
			expect(content).toContain("WaitMsBeforeAsync: 10000");
			expect(content).toContain("schedule` call is a sleep");
			expect(content).toContain("Never end a turn while");
		} finally {
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("appends rules when GEMINI.md exists but lacks T3 orchestration rules", async () => {
		const tempHome = join(tmpdir(), `test-gemini-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const geminiDir = join(tempHome, ".gemini");
		const targetPath = join(geminiDir, "GEMINI.md");
		try {
			mkdirSync(geminiDir, { recursive: true });
			writeFileSync(targetPath, "# Custom Instructions\nAlways speak kindly.\n");

			await ensureGlobalGeminiRules(tempHome);

			const content = readFileSync(targetPath, "utf-8");
			expect(content).toContain("# Custom Instructions");
			expect(content).toContain("# ACP & Multi-Agent Orchestration Rules");
			expect(content).toContain("T3_ACP_MCP_NODE");
		} finally {
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("is idempotent and does not duplicate rules when already present", async () => {
		const tempHome = join(tmpdir(), `test-gemini-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		try {
			await ensureGlobalGeminiRules(tempHome);
			await ensureGlobalGeminiRules(tempHome);

			const targetPath = join(tempHome, ".gemini", "GEMINI.md");
			const content = readFileSync(targetPath, "utf-8");
			const titleMatches = content.match(/# ACP & Multi-Agent Orchestration Rules/g) || [];
			expect(titleMatches.length).toBe(1);
			const nodeMatches = content.match(/T3_ACP_MCP_NODE/g) || [];
			expect(nodeMatches.length).toBe(2); // Occurs twice within the single template block
		} finally {
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("replaces an unmarked legacy rules block instead of duplicating it", async () => {
		const tempHome = join(tmpdir(), `test-gemini-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const geminiDir = join(tempHome, ".gemini");
		const targetPath = join(geminiDir, "GEMINI.md");
		try {
			mkdirSync(geminiDir, { recursive: true });
			// Pre-versioning install: user notes, then the rules with no markers.
			writeFileSync(
				targetPath,
				`${LEGACY_USER_LINE}\n\n${LEGACY_RULES}\n`,
			);

			await ensureGlobalGeminiRules(tempHome);

			const content = readFileSync(targetPath, "utf-8");
			expect(content).toContain(LEGACY_USER_LINE);
			expect(content.match(/# ACP & Multi-Agent Orchestration Rules/g)?.length).toBe(1);
			expect(content).toContain("schedule` call is a sleep");
			expect(content).not.toContain("Always set \\`WaitMsBeforeAsync: 10000\\` (the maximum allowed)");
		} finally {
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("keeps user instructions that precede the managed block", async () => {		const tempHome = join(tmpdir(), `test-gemini-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const geminiDir = join(tempHome, ".gemini");
		const targetPath = join(geminiDir, "GEMINI.md");
		try {
			mkdirSync(geminiDir, { recursive: true });
			writeFileSync(targetPath, `${LEGACY_USER_LINE}\n`);

			await ensureGlobalGeminiRules(tempHome);
			await ensureGlobalGeminiRules(tempHome);

			const content = readFileSync(targetPath, "utf-8");
			expect(content).toContain(LEGACY_USER_LINE);
			expect(content.match(/# ACP & Multi-Agent Orchestration Rules/g)?.length).toBe(1);
		} finally {
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("keeps user text that follows a legacy rules block", async () => {
		const tempHome = join(tmpdir(), `test-gemini-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const geminiDir = join(tempHome, ".gemini");
		const targetPath = join(geminiDir, "GEMINI.md");
		const trailingNote = "# My notes\nPrefer small diffs.";
		try {
			mkdirSync(geminiDir, { recursive: true });
			writeFileSync(targetPath, `${LEGACY_USER_LINE}\n\n${LEGACY_RULES}\n${trailingNote}\n`);

			await ensureGlobalGeminiRules(tempHome);

			const content = readFileSync(targetPath, "utf-8");
			expect(content).toContain(LEGACY_USER_LINE);
			expect(content).toContain(trailingNote);
			expect(content.match(/# ACP & Multi-Agent Orchestration Rules/g)?.length).toBe(1);
		} finally {
			rmSync(tempHome, { recursive: true, force: true });
		}
	});
});
