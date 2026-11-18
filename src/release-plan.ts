/**
 * Deterministic release planning, changelog generation, and Release PR detection
 * shared by local scripts, the `/release` skill, and GitHub Actions workflows.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ReleaseBump = "patch" | "minor" | "major";

export interface RangeCommit {
	sha?: string;
	subject: string;
	body?: string;
	labels?: readonly string[];
}

export interface ParsedConventionalCommit {
	type: string;
	scope?: string;
	breaking: boolean;
	description: string;
}

const CONVENTIONAL_TITLE = /^([a-z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/i;
const CONVENTIONAL_PREFIX = /^([a-z]+)(?:\(([^)]*)\))?(!)?:/i;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/im;
const RELEASE_COMMIT_PREFIX = /^chore\(release\):\s*v?(\d+\.\d+\.\d+)/i;
const CHANGELOG_DOC_COMMIT = /^docs\(changelog\):/i;
const MERGE_COMMIT_SUBJECT = /^Merge (?:pull request #\d+|(?:remote-tracking )?branch )/i;
const TRAILER_LINE = /^(?:Co-authored-by|Signed-off-by|Reviewed-by|Acked-by|BREAKING[ -]CHANGE):/i;

const BUMP_RANK: Record<ReleaseBump, number> = {
	patch: 0,
	minor: 1,
	major: 2,
};

/**
 * Conventional-commit title -> semver bump. `feat:` is a feature, `feat!:` or a
 * `BREAKING CHANGE:` footer is a break, everything else is a patch.
 */
export function deriveBump(title: string, body = ""): ReleaseBump {
	if (BREAKING_FOOTER.test(body)) return "major";
	const match = CONVENTIONAL_PREFIX.exec(title.trim());
	if (!match) return "patch";
	if (match[3]) return "major";
	return match[1]!.toLowerCase() === "feat" ? "minor" : "patch";
}

/** Explicit input beats labels, labels beat the commit message, default patch. */
export function pickBump(input: string, labels: string, commitMessage: string): ReleaseBump {
	const bumpInput = (input ?? "").trim().toLowerCase();
	if (bumpInput === "major" || bumpInput === "minor" || bumpInput === "patch") return bumpInput;
	const names = new Set((labels ?? "").split(",").map(name => name.trim()));
	if (names.has("release:major")) return "major";
	if (names.has("release:minor")) return "minor";
	if ((commitMessage ?? "").includes("[major]")) return "major";
	if ((commitMessage ?? "").includes("[minor]")) return "minor";
	return "patch";
}

export function maxBump(a: ReleaseBump, b: ReleaseBump): ReleaseBump {
	return BUMP_RANK[a] >= BUMP_RANK[b] ? a : b;
}

export function isReleaseCommitMessage(message: string): boolean {
	const firstLine = (message ?? "").split(/\r?\n/, 1)[0]?.trim() ?? "";
	return RELEASE_COMMIT_PREFIX.test(firstLine);
}

export function parseReleaseCommitVersion(message: string): string | undefined {
	const firstLine = (message ?? "").split(/\r?\n/, 1)[0]?.trim() ?? "";
	return RELEASE_COMMIT_PREFIX.exec(firstLine)?.[1];
}

export function isReleasePullRequest(title: string, branch = ""): boolean {
	return isReleaseCommitMessage(title) || /^release\//i.test(branch.trim());
}

/**
 * Aggregate the highest semver bump across a range of commits and/or PRs.
 * Release bookkeeping commits and bare branch merge commits are ignored.
 */
export function deriveRangeBump(commits: readonly RangeCommit[]): ReleaseBump {
	let highest: ReleaseBump = "patch";
	for (const commit of commits) {
		const subject = commit.subject.trim();
		if (!subject || isReleaseCommitMessage(subject) || /^Merge (?:remote-tracking )?branch /i.test(subject)) {
			continue;
		}
		const labelString = (commit.labels ?? []).join(",");
		const fromLabels = pickBump("", labelString, subject);
		const fromCommit = deriveBump(subject, commit.body ?? "");
		highest = maxBump(highest, maxBump(fromLabels, fromCommit));
		if (highest === "major") return "major";
	}
	return highest;
}

export function parseVersion(value: string): [number, number, number] {
	const clean = (value ?? "").trim().replace(/^v/, "").split("-")[0] ?? "0.0.0";
	const [major = 0, minor = 0, patch = 0] = clean.split(".").map(part => Number.parseInt(part, 10) || 0);
	return [major, minor, patch];
}

export function compareVersions(a: string, b: string): number {
	const left = parseVersion(a);
	const right = parseVersion(b);
	for (let index = 0; index < 3; index++) {
		const difference = left[index]! - right[index]!;
		if (difference !== 0) return difference;
	}
	return 0;
}

/** The version a release starts from: whichever of package.json and the tag is newer. */
export function releaseBase(packageVersion: string, tag?: string): string {
	const fromTag = (tag ?? "").trim();
	if (!fromTag) return normalize(packageVersion);
	return compareVersions(packageVersion, fromTag) >= 0 ? normalize(packageVersion) : normalize(fromTag);
}

export function nextVersion(base: string, bump: ReleaseBump): string {
	const [major, minor, patch] = parseVersion(base);
	if (bump === "major") return `${major + 1}.0.0`;
	if (bump === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

export function parseConventionalCommit(subject: string, body = ""): ParsedConventionalCommit | null {
	const trimmed = subject.trim();
	const match = CONVENTIONAL_TITLE.exec(trimmed);
	if (!match) return null;
	const [, rawType, rawScope, bang, description] = match;
	return {
		type: rawType!.toLowerCase(),
		scope: rawScope?.trim() || undefined,
		breaking: Boolean(bang) || BREAKING_FOOTER.test(body),
		description: description!.trim(),
	};
}

type ChangelogCategory = "Breaking Changes" | "Added" | "Changed" | "Fixed" | "Removed" | "Maintenance";

const CATEGORY_ORDER: readonly ChangelogCategory[] = [
	"Breaking Changes",
	"Added",
	"Changed",
	"Fixed",
	"Removed",
	"Maintenance",
];

function classifyCommit(parsed: ParsedConventionalCommit | null, body: string): ChangelogCategory {
	if (parsed?.breaking || BREAKING_FOOTER.test(body)) return "Breaking Changes";
	switch (parsed?.type) {
		case "feat":
			return "Added";
		case "fix":
			return "Fixed";
		case "revert":
			return "Removed";
		case "perf":
		case "refactor":
		case "build":
		case "deps":
			return "Changed";
		case "docs":
		case "test":
		case "ci":
		case "chore":
		case "style":
			return "Maintenance";
		default:
			return "Changed";
	}
}

function cleanCommitBodyLines(body: string): string[] {
	const lines = (body ?? "").split(/\r?\n/);
	const kept: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push("");
			continue;
		}
		if (TRAILER_LINE.test(trimmed)) continue;
		kept.push(trimmed);
	}
	while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
	return kept;
}

function formatCommitBullet(commit: RangeCommit, includeBodies: boolean): string {
	const parsed = parseConventionalCommit(commit.subject, commit.body);
	const text = parsed
		? parsed.scope
			? `**${parsed.scope}**: ${parsed.description}`
			: parsed.description
		: commit.subject.trim();
	const bullet = `- ${text}`;
	if (!includeBodies || !commit.body) return bullet;
	const bodyLines = cleanCommitBodyLines(commit.body);
	if (bodyLines.length === 0) return bullet;
	const indented = bodyLines.map(line => (line ? `  ${line}` : "")).join("\n");
	return `${bullet}\n${indented}`;
}

/**
 * Format a Keep a Changelog section body deterministically from commits in a range.
 */
export function formatChangelogSectionBody(
	commits: readonly RangeCommit[],
	options: {
		repo?: string;
		previousTag?: string;
		currentTag?: string;
		includeBodies?: boolean;
	} = {},
): string {
	const includeBodies = options.includeBodies ?? true;
	const buckets = new Map<ChangelogCategory, string[]>();
	for (const category of CATEGORY_ORDER) buckets.set(category, []);

	for (const commit of commits) {
		const subject = commit.subject.trim();
		if (!subject) continue;
		if (isReleaseCommitMessage(subject) || CHANGELOG_DOC_COMMIT.test(subject) || MERGE_COMMIT_SUBJECT.test(subject)) {
			continue;
		}
		const parsed = parseConventionalCommit(subject, commit.body);
		const category = classifyCommit(parsed, commit.body ?? "");
		buckets.get(category)!.push(formatCommitBullet(commit, includeBodies));
	}

	const sections: string[] = [];
	for (const category of CATEGORY_ORDER) {
		const items = buckets.get(category)!;
		if (items.length === 0) continue;
		sections.push(`### ${category}\n\n${items.join("\n")}`);
	}

	if (sections.length === 0) {
		sections.push("### Maintenance\n\n- Maintenance release.");
	}

	if (options.repo && options.previousTag && options.currentTag) {
		sections.push(
			`[Full Changelog](https://github.com/${options.repo}/compare/${options.previousTag}...${options.currentTag})`,
		);
	}

	return sections.join("\n\n");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract the markdown body for `## [<version>]` from a Keep a Changelog file. */
export function extractChangelogSection(changelogText: string, version: string): string | undefined {
	const cleanVersion = version.trim().replace(/^v/, "");
	const normalized = changelogText.replace(/\r\n/g, "\n");
	const headerPattern = new RegExp(`^## \\[${escapeRegExp(cleanVersion)}\\][^\\n]*\\n`, "m");
	const match = headerPattern.exec(normalized);
	if (!match) return undefined;

	const start = match.index + match[0].length;
	const rest = normalized.slice(start);
	const nextHeading = /\n## \[/.exec(rest);
	const section = (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();
	return section || undefined;
}

/** Insert or replace `## [<version>] - <date>` right below `## [Unreleased]`. */
export function upsertChangelogSection(
	changelogText: string,
	version: string,
	date: string,
	body: string,
): string {
	const cleanVersion = version.trim().replace(/^v/, "");
	const normalized = changelogText.replace(/\r\n/g, "\n");
	const heading = `## [${cleanVersion}] - ${date}`;
	const newBlock = `${heading}\n\n${body.trim()}\n`;

	const existingHeader = new RegExp(`^## \\[${escapeRegExp(cleanVersion)}\\][^\\n]*\\n`, "m");
	const existingMatch = existingHeader.exec(normalized);
	if (existingMatch) {
		const blockStart = existingMatch.index;
		const contentStart = blockStart + existingMatch[0].length;
		const nextSectionOffset = normalized.indexOf("\n## [", contentStart);
		const blockEnd = nextSectionOffset >= 0 ? nextSectionOffset + 1 : normalized.length;
		const before = normalized.slice(0, blockStart);
		const after = normalized.slice(blockEnd).replace(/^\n+/, "");
		return `${before}${newBlock}${after ? `\n${after}` : ""}`.replace(/\n*$/, "\n");
	}

	const unreleasedPattern = /^## \[Unreleased\]\s*\n+/m;
	const unreleasedMatch = unreleasedPattern.exec(normalized);
	if (unreleasedMatch) {
		const insertAt = unreleasedMatch.index + unreleasedMatch[0].length;
		const before = normalized.slice(0, unreleasedMatch.index) + "## [Unreleased]\n\n";
		const after = normalized.slice(insertAt).replace(/^\n+/, "");
		return `${before}${newBlock}${after ? `\n${after}` : ""}`.replace(/\n*$/, "\n");
	}

	return `# Changelog\n\n## [Unreleased]\n\n${newBlock}\n${normalized.trimStart()}`.replace(/\n*$/, "\n");
}

function normalize(value: string): string {
	const [major, minor, patch] = parseVersion(value);
	return `${major}.${minor}.${patch}`;
}

function flag(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
	return args.includes(name);
}

function runGit(args: string[], cwd = process.cwd(), allowFailure = false): string {
	const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		if (allowFailure) return "";
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
	}
	return result.stdout.toString().trim();
}

export function latestGitTag(cwd = process.cwd()): string | undefined {
	const output = runGit(["tag", "--list", "v*", "--sort=-v:refname"], cwd, true);
	const first = output.split(/\r?\n/).find(Boolean)?.trim();
	return first || undefined;
}

export function readGitRangeCommits(baseRef: string, headRef = "HEAD", cwd = process.cwd()): RangeCommit[] {
	const range = baseRef ? `${baseRef}..${headRef}` : headRef;
	const output = runGit(["log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", range], cwd);
	if (!output) return [];
	return output
		.split("\x1e")
		.map(record => record.trim())
		.filter(Boolean)
		.map(record => {
			const [sha = "", subject = "", body = ""] = record.split("\x1f");
			return { sha: sha.trim(), subject: subject.trim(), body: body.trim() };
		})
		.filter(entry => entry.subject.length > 0);
}

function readPackageVersionAtRef(ref: string, cwd = process.cwd()): string {
	if (!ref || /^0+$/.test(ref)) return "0.0.0";
	const raw = runGit(["show", `${ref}:package.json`], cwd, true);
	if (!raw) return "0.0.0";
	try {
		const parsed = JSON.parse(raw) as { version?: string };
		return parsed.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

function readPackageVersion(cwd = process.cwd()): string {
	const pkgPath = join(cwd, "package.json");
	if (!existsSync(pkgPath)) return "0.0.0";
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
	return pkg.version ?? "0.0.0";
}

function writePackageVersion(version: string, cwd = process.cwd()): void {
	const pkgPath = join(cwd, "package.json");
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
	pkg.version = version;
	writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

function tagExists(tag: string, cwd = process.cwd()): boolean {
	const result = Bun.spawnSync({
		cmd: ["git", "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`],
		cwd,
		stdout: "ignore",
		stderr: "ignore",
	});
	return result.exitCode === 0;
}

function parseExtraLabelCommits(jsonArg: string | undefined): RangeCommit[] {
	if (!jsonArg) return [];
	const parsed = JSON.parse(jsonArg) as Array<{ subject?: string; body?: string; labels?: string[] }>;
	return parsed.map(item => ({
		subject: item.subject ?? "",
		body: item.body ?? "",
		labels: item.labels ?? [],
	}));
}

function computePlan(args: string[], cwd = process.cwd()) {
	const previousTag = flag(args, "--from") ?? latestGitTag(cwd) ?? "";
	const headRef = flag(args, "--to") ?? "HEAD";
	const pkgVersion = flag(args, "--package") ?? readPackageVersion(cwd);
	const repo = flag(args, "--repo");
	const explicitVersion = flag(args, "--version")?.trim().replace(/^v/, "");
	const requestedBump = (flag(args, "--bump") ?? "auto").trim().toLowerCase();

	const commits = readGitRangeCommits(previousTag, headRef, cwd);
	const extraItems = parseExtraLabelCommits(flag(args, "--pr-labels-json"));
	const base = releaseBase(pkgVersion, previousTag);

	let bump: ReleaseBump;
	if (requestedBump === "major" || requestedBump === "minor" || requestedBump === "patch") {
		bump = requestedBump;
	} else {
		bump = deriveRangeBump([...commits, ...extraItems]);
	}

	const version = explicitVersion || nextVersion(base, bump);
	const tag = `v${version}`;
	const notes = formatChangelogSectionBody(commits, {
		repo,
		previousTag: previousTag || undefined,
		currentTag: tag,
	});

	return {
		previousTag,
		base,
		bump,
		version,
		tag,
		commitCount: commits.filter(c => !isReleaseCommitMessage(c.subject) && !CHANGELOG_DOC_COMMIT.test(c.subject))
			.length,
		commits,
		notes,
	};
}

function detectReleasePullRequest(args: string[], cwd = process.cwd()) {
	const beforeRef = flag(args, "--before") ?? "";
	const afterRef = flag(args, "--after") ?? "HEAD";
	const prTitle = flag(args, "--pr-title") ?? "";
	const prBranch = flag(args, "--pr-branch") ?? "";
	const commitMessage = flag(args, "--commit-message") ?? runGit(["log", "-1", "--format=%s", afterRef], cwd, true);

	const beforeVersion = readPackageVersionAtRef(beforeRef, cwd);
	const afterVersion = readPackageVersionAtRef(afterRef, cwd);
	const latestTag = latestGitTag(cwd);

	if (compareVersions(afterVersion, beforeVersion) <= 0) {
		return {
			shouldRelease: false,
			reason: `package.json version did not increase (${beforeVersion} -> ${afterVersion})`,
		};
	}

	const intentMatched =
		isReleaseCommitMessage(commitMessage) || isReleasePullRequest(prTitle, prBranch);
	if (!intentMatched) {
		return {
			shouldRelease: false,
			reason: "commit/PR does not carry release PR intent (chore(release): or release/ branch)",
		};
	}

	const version = normalize(afterVersion);
	const tag = `v${version}`;
	if (latestTag && compareVersions(version, latestTag) <= 0) {
		return {
			shouldRelease: false,
			reason: `version ${version} is not newer than latest tag ${latestTag}`,
		};
	}

	if (tagExists(tag, cwd)) {
		return {
			shouldRelease: false,
			reason: `tag ${tag} already exists`,
		};
	}

	return {
		shouldRelease: true,
		version,
		tag,
		previousTag: latestTag ?? "",
		reason: `Release PR bumped package.json ${beforeVersion} -> ${version}`,
	};
}

if (import.meta.main) {
	const [command, ...rest] = Bun.argv.slice(2);
	if (command === "derive") {
		console.log(deriveBump(rest[0] ?? "", rest[1] ?? ""));
	} else if (command === "pick") {
		console.log(pickBump(rest[0] ?? "", rest[1] ?? "", rest[2] ?? ""));
	} else if (command === "base") {
		console.log(releaseBase(rest[0] ?? "", rest[1]));
	} else if (command === "next") {
		console.log(nextVersion(rest[0] ?? "0.0.0", (rest[1] ?? "patch") as ReleaseBump));
	} else if (command === "resolve") {
		const bump = (flag(rest, "--bump") ?? "patch") as ReleaseBump;
		const base = releaseBase(flag(rest, "--package") ?? "0.0.0", flag(rest, "--tag"));
		console.log(JSON.stringify({ base, bump, version: nextVersion(base, bump) }));
	} else if (command === "plan") {
		console.log(JSON.stringify(computePlan(rest)));
	} else if (command === "prepare") {
		const plan = computePlan(rest);
		const date = flag(rest, "--date") ?? new Date().toISOString().slice(0, 10);
		if (hasFlag(rest, "--write") && !hasFlag(rest, "--dry-run")) {
			writePackageVersion(plan.version);
			const changelogPath = join(process.cwd(), "CHANGELOG.md");
			const existing = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "# Changelog\n\n## [Unreleased]\n";
			writeFileSync(changelogPath, upsertChangelogSection(existing, plan.version, date, plan.notes));
		}
		console.log(JSON.stringify({ ...plan, date }));
	} else if (command === "notes") {
		const version = (flag(rest, "--version") ?? readPackageVersion()).replace(/^v/, "");
		const changelogPath = flag(rest, "--changelog") ?? join(process.cwd(), "CHANGELOG.md");
		const existing = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
		const extracted = extractChangelogSection(existing, version);
		if (extracted) {
			console.log(extracted);
		} else {
			const previousTag = flag(rest, "--from") ?? latestGitTag() ?? "";
			const commits = readGitRangeCommits(previousTag, "HEAD");
			console.log(
				formatChangelogSectionBody(commits, {
					repo: flag(rest, "--repo"),
					previousTag: previousTag || undefined,
					currentTag: `v${version}`,
				}),
			);
		}
	} else if (command === "detect-release-pr") {
		console.log(JSON.stringify(detectReleasePullRequest(rest)));
	} else {
		console.error(
			"usage: release-plan.ts <derive|pick|base|next|resolve|plan|prepare|notes|detect-release-pr> [options]",
		);
		process.exit(1);
	}
}
