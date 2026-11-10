import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import {
	buildInjectedPrompt,
	buildSkillsBlock,
	findSkill,
	listUserSkills,
	parseSkillMarkdown,
	resolvePromptText,
} from "../src/injection";

describe("subagent prompt and skill injection", () => {
	it("resolves prompt text from string or file path", () => {
		expect(resolvePromptText("Hello world")).toBe("Hello world");
		expect(resolvePromptText(undefined)).toBeUndefined();

		const tempFile = join(tmpdir(), `test-prompt-${Date.now()}.txt`);
		writeFileSync(tempFile, "Content from file");
		try {
			expect(resolvePromptText(tempFile)).toBe("Content from file");
		} finally {
			unlinkSync(tempFile);
		}
	});

	it("parses skill markdown and frontmatter", () => {
		const rawWithFm = `---
name: my-skill
description: A helpful test skill
---

# Instructions
Do the thing properly.`;

		const parsed = parseSkillMarkdown(rawWithFm);
		expect(parsed.description).toBe("A helpful test skill");
		expect(parsed.body).toBe("# Instructions\nDo the thing properly.");

		const rawWithoutFm = "# Direct Content";
		const parsed2 = parseSkillMarkdown(rawWithoutFm);
		expect(parsed2.description).toBe("");
		expect(parsed2.body).toBe("# Direct Content");
	});

	it("finds skill and builds skills block", () => {
		const testDir = join(tmpdir(), `skills-test-${Date.now()}`);
		const skillDir = join(testDir, "code-review");
		mkdirSync(skillDir, { recursive: true });

		const skillContent = `---
name: code-review
description: Reviews pull requests and diffs
---

# Instructions
Check for style and correctness.`;

		writeFileSync(join(skillDir, "SKILL.md"), skillContent);

		try {
			const found = findSkill(skillDir);
			expect(found).not.toBeNull();
			expect(found!.name).toBe("code-review");
			expect(found!.description).toBe("Reviews pull requests and diffs");
			expect(found!.content).toContain("Check for style and correctness.");

			const block = buildSkillsBlock([skillDir]);
			expect(block).toContain("<skills>");
			expect(block).toContain("Available skills:");
			expect(block).toContain("- code-review");
			expect(block).toContain("Reviews pull requests and diffs");
			expect(block).toContain("### Skill: code-review");
			expect(block).toContain("</skills>");
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("builds injected subagent prompt with clean, systemPrompt, and appendSystemPrompt", () => {
		// Clean mode default instruction
		const cleanPrompt = buildInjectedPrompt({
			prompt: "Do task",
			clean: true,
		});
		expect(cleanPrompt).toContain("<system_instruction>");
		expect(cleanPrompt).toContain("minimal, lightweight subagent");
		expect(cleanPrompt).toContain("Do task");

		// Custom system prompt and append prompt
		const customPrompt = buildInjectedPrompt({
			prompt: "Inspect code",
			systemPrompt: "You are a senior reviewer",
			appendSystemPrompt: "Output JSON only",
		});
		expect(customPrompt).toContain("<system_instruction>\nYou are a senior reviewer\n</system_instruction>");
		expect(customPrompt).toContain("Inspect code");
		expect(customPrompt).toContain("<additional_instructions>\nOutput JSON only\n</additional_instructions>");
	});

	it("lists user skills from workspace and primary directories", () => {
		const testDir = join(tmpdir(), `user-skills-test-${Date.now()}`);
		const wsSkillDir = join(testDir, ".gemini", "skills", "custom-ws-skill");
		mkdirSync(wsSkillDir, { recursive: true });
		writeFileSync(
			join(wsSkillDir, "SKILL.md"),
			`---
name: custom-ws-skill
description: Workspace-specific skill
---
# Instructions
Do something in workspace.`,
		);

		try {
			const skills = listUserSkills(testDir);
			const found = skills.find(s => s.name === "custom-ws-skill");
			expect(found).toBeDefined();
			expect(found!.description).toBe("Workspace-specific skill");
			expect(found!.path).toBe(join(wsSkillDir, "SKILL.md"));
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});
});
