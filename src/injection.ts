import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface ResolvedSkill {
	name: string;
	path: string;
	description: string;
	content: string;
}

export interface DiscoveredSkill {
	name: string;
	description: string;
	path: string;
}

/**
 * Lists all available skills strictly from the primary user home directory
 * (~/.gemini/skills, ~/.gemini/config/skills, ~/.gemini/antigravity-cli/skills,
 * ~/.gemini/antigravity-cli/builtin/skills, plugins) and project roots.
 * Never stores or scans from profile-specific isolated directories.
 */
export function listUserSkills(cwd?: string): DiscoveredSkill[] {
	const home = process.env.REAL_HOME || homedir();
	const roots = [
		join(home, ".gemini", "skills"),
		join(home, ".agents", "skills"),
		join(home, ".gemini", "config", "skills"),
		join(home, ".gemini", "antigravity-cli", "skills"),
		join(home, ".gemini", "antigravity-cli", "builtin", "skills"),
	];

	const pluginsDir = join(home, ".gemini", "config", "plugins");
	if (existsSync(pluginsDir)) {
		try {
			const entries = readdirSync(pluginsDir);
			for (const entry of entries) {
				const pluginSkills = join(pluginsDir, entry, "skills");
				if (existsSync(pluginSkills)) {
					roots.push(pluginSkills);
				}
			}
		} catch {
			// ignore directory read issues
		}
	}

	if (cwd) {
		roots.push(
			join(cwd, ".gemini", "skills"),
			join(cwd, ".agents", "skills"),
			join(cwd, ".agent", "skills"),
			join(cwd, "skills"),
		);
	}

	const skills = new Map<string, DiscoveredSkill>();

	for (const root of roots) {
		if (!existsSync(root)) continue;
		try {
			const entries = readdirSync(root);
			for (const entryName of entries) {
				const full = join(root, entryName);
				try {
					const st = statSync(full); // follows symlinks!
					let skillPath: string | null = null;
					let defaultName = entryName;

					if (st.isDirectory()) {
						const candidate = join(full, "SKILL.md");
						if (existsSync(candidate)) {
							skillPath = candidate;
						}
					} else if (entryName.endsWith(".md")) {
						skillPath = full;
						defaultName = entryName.slice(0, -3);
					}

					if (skillPath) {
						try {
							const raw = readFileSync(skillPath, "utf-8");
							const { description } = parseSkillMarkdown(raw);
							let skillName = defaultName;
							const matchName = raw.match(/^---\r?\n[\s\S]*?\bname:\s*([^\r\n]+)/i);
							if (matchName && matchName[1]) {
								skillName = matchName[1].trim().replace(/^['"]|['"]$/g, "");
							}
							if (!skills.has(skillName)) {
								skills.set(skillName, {
									name: skillName,
									description: description || `${skillName} skill`,
									path: resolve(skillPath),
								});
							}
						} catch {
							// ignore single skill read issue
						}
					}
				} catch {
					// broken symlink or inaccessible file
				}
			}
		} catch {
			// ignore directory read issues
		}
	}

	return Array.from(skills.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolves prompt text: if input matches an existing file, its content is read;
 * otherwise the literal string is used.
 */
export function resolvePromptText(input?: string): string | undefined {
	if (!input) return undefined;
	const trimmed = input.trim();
	if (existsSync(trimmed)) {
		try {
			const stat = statSync(trimmed);
			if (stat.isFile()) {
				return readFileSync(trimmed, "utf-8").trim();
			}
		} catch {
			// Fallback to literal string if read fails
		}
	}
	return trimmed;
}

/**
 * Parses simple YAML frontmatter from a SKILL.md file.
 * Returns extracted description and the content without frontmatter.
 */
export function parseSkillMarkdown(content: string): { description: string; body: string } {
	const trimmed = content.trim();
	if (!trimmed.startsWith("---")) {
		return { description: "", body: trimmed };
	}

	const endMatch = trimmed.indexOf("\n---", 3);
	if (endMatch === -1) {
		return { description: "", body: trimmed };
	}

	const frontmatter = trimmed.slice(3, endMatch).trim();
	const body = trimmed.slice(endMatch + 4).trim();

	let description = "";
	for (const line of frontmatter.split("\n")) {
		const match = line.match(/^description:\s*(.+)$/i);
		if (match && match[1]) {
			description = match[1].trim().replace(/^['"]|['"]$/g, "");
			break;
		}
	}

	return { description, body };
}

/**
 * Searches for a skill by identifier (direct file/dir path, or name across standard skill locations).
 */
export function findSkill(identifier: string, searchRoots?: string[]): ResolvedSkill | null {
	const trimmed = identifier.trim();
	if (!trimmed) return null;

	const candidatePaths: string[] = [];

	// 1. Direct path
	if (existsSync(trimmed)) {
		const stat = statSync(trimmed);
		if (stat.isDirectory()) {
			candidatePaths.push(join(trimmed, "SKILL.md"));
		} else if (stat.isFile()) {
			candidatePaths.push(trimmed);
		}
	}

	// 2. Standard search directories strictly from primary user home
	const home = process.env.REAL_HOME || homedir();
	const roots = searchRoots ?? [
		join(home, ".gemini", "skills"),
		join(home, ".agents", "skills"),
		join(home, ".gemini", "config", "skills"),
		join(home, ".gemini", "antigravity-cli", "skills"),
		join(home, ".gemini", "antigravity-cli", "builtin", "skills"),
		join(process.cwd(), ".gemini", "skills"),
		join(process.cwd(), ".agents", "skills"),
		join(process.cwd(), "skills"),
	];

	for (const root of roots) {
		if (!existsSync(root)) continue;
		candidatePaths.push(join(root, trimmed, "SKILL.md"));
		candidatePaths.push(join(root, `${trimmed}.md`));
	}

	// Also check plugin skills: ~/.gemini/config/plugins/*/skills/<identifier>/SKILL.md
	const pluginsDir = join(home, ".gemini", "config", "plugins");
	if (existsSync(pluginsDir)) {
		try {
			const entries = readdirSync(pluginsDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					candidatePaths.push(join(pluginsDir, entry.name, "skills", trimmed, "SKILL.md"));
				}
			}
		} catch {
			// ignore directory read issues
		}
	}

	for (const p of candidatePaths) {
		if (existsSync(p)) {
			try {
				const stat = statSync(p);
				if (stat.isFile()) {
					const raw = readFileSync(p, "utf-8");
					const { description, body } = parseSkillMarkdown(raw);
					const skillDir = dirname(p);
					const name = basename(p) === "SKILL.md" ? basename(skillDir) : basename(p, ".md");
					return {
						name,
						path: resolve(p),
						description,
						content: body,
					};
				}
			} catch {
				// ignore read error and try next
			}
		}
	}

	return null;
}

/**
 * Formats a list of skill identifiers into an Antigravity <skills> block.
 */
export function buildSkillsBlock(identifiers: string[]): string {
	const skills: ResolvedSkill[] = [];
	for (const id of identifiers) {
		const resolved = findSkill(id);
		if (resolved) {
			skills.push(resolved);
		}
	}

	if (!skills.length) return "";

	const lines: string[] = [];
	lines.push("<skills>");
	lines.push("You can use the following specialized skills for this task:\n");
	lines.push("Available skills:");
	for (const s of skills) {
		const desc = s.description ? `: ${s.description}` : "";
		lines.push(`- ${s.name} (${s.path})${desc}`);
	}

	lines.push("\n## Skill Instructions");
	for (const s of skills) {
		lines.push(`\n### Skill: ${s.name}`);
		lines.push(s.content);
	}
	lines.push("</skills>");

	return lines.join("\n");
}

export interface InjectedPromptOptions {
	prompt: string;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	skills?: string[];
	clean?: boolean;
}

/**
 * Assembles the full prompt with optional system instructions, skills block,
 * and additional instructions.
 */
export function buildInjectedPrompt(options: InjectedPromptOptions): string {
	const parts: string[] = [];

	const systemPrompt = resolvePromptText(options.systemPrompt);
	const appendSystemPrompt = resolvePromptText(options.appendSystemPrompt);

	if (systemPrompt) {
		parts.push(`<system_instruction>\n${systemPrompt}\n</system_instruction>`);
	} else if (options.clean) {
		parts.push(
			`<system_instruction>\nYou are a minimal, lightweight subagent focused strictly on executing the given task without loading unneeded background skills or extensions.\n</system_instruction>`,
		);
	}

	if (options.skills && options.skills.length > 0) {
		const skillsBlock = buildSkillsBlock(options.skills);
		if (skillsBlock) {
			parts.push(skillsBlock);
		}
	}

	parts.push(options.prompt);

	if (appendSystemPrompt) {
		parts.push(`<additional_instructions>\n${appendSystemPrompt}\n</additional_instructions>`);
	}

	return parts.join("\n\n");
}
