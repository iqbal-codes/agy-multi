import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	compareVersions,
	deriveBump,
	deriveRangeBump,
	extractChangelogSection,
	formatChangelogSectionBody,
	isReleaseCommitMessage,
	isReleasePullRequest,
	maxBump,
	nextVersion,
	parseReleaseCommitVersion,
	parseVersion,
	pickBump,
	releaseBase,
	upsertChangelogSection,
} from "../src/release-plan";

describe("release plan", () => {
	test("derives the bump from a conventional title", () => {
		expect(deriveBump("feat: add use command")).toBe("minor");
		expect(deriveBump("feat(acp): sequential mode")).toBe("minor");
		expect(deriveBump("feat!: drop the old flag")).toBe("major");
		expect(deriveBump("feat(acp)!: drop the old flag")).toBe("major");
		expect(deriveBump("fix: stop killing the other turn")).toBe("patch");
		expect(deriveBump("docs: rewrite the README")).toBe("patch");
		expect(deriveBump("chore(release): v0.3.0 [skip ci]")).toBe("patch");
		expect(deriveBump("Merge pull request #2 from a/branch")).toBe("patch");
	});

	test("only a footer line marks a breaking change", () => {
		expect(deriveBump("fix: rename the state root", "BREAKING CHANGE: ~/.agy moved")).toBe("major");
		expect(deriveBump("fix: rename the state root", "note\n\nBREAKING-CHANGE: ~/.agy moved")).toBe("major");
		// Prose that talks *about* breaking changes must not bump the major digit.
		expect(deriveBump("fix: plan docs", "`feat!:` or a `BREAKING CHANGE` footer is major")).toBe("patch");
		expect(deriveBump("feat: plan docs", "see BREAKING CHANGE for details")).toBe("minor");
		expect(deriveBump("feat: x", "no breaking marker here")).toBe("minor");
	});

	test("explicit input beats labels, labels beat the commit message", () => {
		expect(pickBump("patch", "release:major,release:minor", "[major]")).toBe("patch");
		expect(pickBump("", "release:major,release:minor", "")).toBe("major");
		expect(pickBump("", "release:minor", "[major]")).toBe("minor");
		expect(pickBump("", "", "feat: x [minor]")).toBe("minor");
		expect(pickBump("", "", "feat: x [major]")).toBe("major");
		expect(pickBump("", "", "fix: x")).toBe("patch");
		expect(pickBump("nonsense", "", "")).toBe("patch");
	});

	test("starts from whichever of package.json and the tag is newer", () => {
		expect(releaseBase("0.2.0", "v0.3.0")).toBe("0.3.0");
		expect(releaseBase("0.3.0", "v0.2.0")).toBe("0.3.0");
		expect(releaseBase("v0.2.0", undefined)).toBe("0.2.0");
		expect(releaseBase("0.2.0", "")).toBe("0.2.0");
		expect(compareVersions("0.3.0", "v0.3.0")).toBe(0);
		expect(compareVersions("0.2.9", "0.3.0")).toBeLessThan(0);
	});

	test("bumps without rolling the wrong digit", () => {
		expect(nextVersion("0.3.0", "patch")).toBe("0.3.1");
		expect(nextVersion("0.3.0", "minor")).toBe("0.4.0");
		expect(nextVersion("0.3.0", "major")).toBe("1.0.0");
		expect(nextVersion("0.0.9", "patch")).toBe("0.0.10");
		expect(parseVersion("v1.2.3-beta.1")).toEqual([1, 2, 3]);
	});

	test("the CLI answers the way the workflows call it", () => {
		const script = join(import.meta.dir, "..", "src", "release-plan.ts");
		const run = (args: string[]) => {
			const result = Bun.spawnSync({ cmd: [process.execPath, script, ...args], stdout: "pipe", stderr: "pipe" });
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
			return result.stdout.toString().trim();
		};
		expect(run(["derive", "feat: x"])).toBe("minor");
		expect(run(["pick", "", "release:minor", ""])).toBe("minor");
		expect(run(["base", "0.2.0", "v0.3.0"])).toBe("0.3.0");
		expect(run(["resolve", "--package", "0.3.0", "--tag", "v0.3.0", "--bump", "minor"])).toBe(
			'{"base":"0.3.0","bump":"minor","version":"0.4.0"}',
		);
	});

	test("aggregates the highest bump across a commit range", () => {
		expect(maxBump("patch", "minor")).toBe("minor");
		expect(maxBump("minor", "major")).toBe("major");
		expect(maxBump("major", "patch")).toBe("major");

		expect(
			deriveRangeBump([
				{ subject: "fix: tighten timeout" },
				{ subject: "docs: update readme" },
				{ subject: "chore(release): v0.5.1 [skip ci]" },
			]),
		).toBe("patch");

		expect(
			deriveRangeBump([
				{ subject: "fix: tighten timeout" },
				{ subject: "feat(cli): add release command" },
				{ subject: "test: add coverage" },
			]),
		).toBe("minor");

		expect(
			deriveRangeBump([
				{ subject: "fix: tighten timeout", labels: ["release:minor"] },
				{ subject: "chore: cleanup" },
			]),
		).toBe("minor");

		expect(
			deriveRangeBump([
				{ subject: "feat: add command" },
				{ subject: "fix: drop old flag", body: "Some details\n\nBREAKING CHANGE: removed --legacy" },
			]),
		).toBe("major");
	});

	test("recognizes release commits and release pull requests", () => {
		expect(isReleaseCommitMessage("chore(release): v0.6.0")).toBe(true);
		expect(isReleaseCommitMessage("chore(release): v0.6.0 [skip ci]")).toBe(true);
		expect(isReleaseCommitMessage("chore: regular task")).toBe(false);

		expect(parseReleaseCommitVersion("chore(release): v0.6.0 (#12)")).toBe("0.6.0");
		expect(parseReleaseCommitVersion("Merge pull request #12")).toBeUndefined();

		expect(isReleasePullRequest("chore(release): v0.6.0", "feature/x")).toBe(true);
		expect(isReleasePullRequest("Release 0.6.0", "release/v0.6.0")).toBe(true);
		expect(isReleasePullRequest("fix: bug", "fix/bug")).toBe(false);
	});

	test("formats deterministic Keep a Changelog sections from commits and bodies", () => {
		const body = formatChangelogSectionBody(
			[
				{ sha: "1111111aaaa", subject: "feat(cli): add batch release (#10)", body: "Supports multi-PR batching.\n\nCo-authored-by: Bot <bot@example.com>" },
				{ sha: "2222222bbbb", subject: "fix(proxy): avoid hang on EOF" },
				{ sha: "3333333cccc", subject: "feat!: drop v1 state", body: "BREAKING CHANGE: state v1 is no longer loaded" },
				{ sha: "4444444dddd", subject: "chore(release): v0.5.1 [skip ci]" },
				{ sha: "5555555eeee", subject: "docs(changelog): publish the 0.5.1 section" },
				{ sha: "6666666ffff", subject: "test: cover edge case" },
			],
			{ repo: "iqbal-codes/agy-multi", previousTag: "v0.5.1", currentTag: "v1.0.0" },
		);

		expect(body).toContain("### Breaking Changes");
		expect(body).toContain("drop v1 state");
		expect(body).toContain("### Added");
		expect(body).toContain("**cli**: add batch release (#10)");
		expect(body).toContain("Supports multi-PR batching.");
		expect(body).not.toContain("Co-authored-by:");
		expect(body).toContain("### Fixed");
		expect(body).toContain("**proxy**: avoid hang on EOF");
		expect(body).toContain("### Maintenance");
		expect(body).toContain("cover edge case");
		expect(body).not.toContain("chore(release): v0.5.1");
		expect(body).not.toContain("publish the 0.5.1 section");
		expect(body).toContain("[Full Changelog](https://github.com/iqbal-codes/agy-multi/compare/v0.5.1...v1.0.0)");
	});

	test("upserts and extracts version sections in CHANGELOG.md idempotently", () => {
		const initial = `# Changelog\n\n## [Unreleased]\n\n## [0.5.1] - 2026-11-18\n\n### Fixed\n\n- Old fix.\n`;
		const first = upsertChangelogSection(initial, "0.6.0", "2026-11-19", "### Added\n\n- New feature.");
		expect(first).toContain("## [Unreleased]\n\n## [0.6.0] - 2026-11-19\n\n### Added\n\n- New feature.\n\n## [0.5.1] - 2026-11-18");

		const updated = upsertChangelogSection(first, "0.6.0", "2026-11-20", "### Added\n\n- Refined summary.");
		expect(updated.match(/## \[0\.6\.0\]/g)?.length).toBe(1);
		expect(updated).toContain("## [0.6.0] - 2026-11-20");
		expect(updated).toContain("- Refined summary.");
		expect(updated).not.toContain("- New feature.");

		expect(extractChangelogSection(updated, "0.6.0")).toBe("### Added\n\n- Refined summary.");
		expect(extractChangelogSection(updated, "0.5.1")).toBe("### Fixed\n\n- Old fix.");
		expect(extractChangelogSection(updated, "9.9.9")).toBeUndefined();
	});

	test("supports plan, prepare, notes, and detect-release-pr CLI commands in a git repo", () => {
		const dir = mkdtempSync(join(tmpdir(), "agy-release-plan-"));
		try {
			const git = (...args: string[]) => {
				const res = Bun.spawnSync({ cmd: ["git", ...args], cwd: dir, stdout: "pipe", stderr: "pipe" });
				if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
				return res.stdout.toString().trim();
			};
			git("init");
			git("config", "user.name", "Test");
			git("config", "user.email", "test@example.com");

			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "agy-multi", version: "0.5.1" }, null, 2) + "\n");
			writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [0.5.1] - 2026-11-18\n\n### Fixed\n\n- Base.\n");
			git("add", ".");
			git("commit", "-m", "chore(release): v0.5.1");
			git("tag", "-a", "v0.5.1", "-m", "Release v0.5.1");

			writeFileSync(join(dir, "a.txt"), "one\n");
			git("add", ".");
			git("commit", "-m", "fix: first patch");

			writeFileSync(join(dir, "b.txt"), "two\n");
			git("add", ".");
			git("commit", "-m", "feat(acp): second change");

			const headBeforeRelease = git("rev-parse", "HEAD");
			const script = join(import.meta.dir, "..", "src", "release-plan.ts");
			const runCli = (args: string[]) => {
				const res = Bun.spawnSync({ cmd: [process.execPath, script, ...args], cwd: dir, stdout: "pipe", stderr: "pipe" });
				if (res.exitCode !== 0) throw new Error(res.stderr.toString());
				return res.stdout.toString().trim();
			};

			const plan = JSON.parse(runCli(["plan", "--from", "v0.5.1", "--repo", "iqbal-codes/agy-multi"]));
			expect(plan.base).toBe("0.5.1");
			expect(plan.bump).toBe("minor");
			expect(plan.version).toBe("0.6.0");
			expect(plan.tag).toBe("v0.6.0");
			expect(plan.commitCount).toBe(2);
			expect(plan.notes).toContain("### Added");
			expect(plan.notes).toContain("**acp**: second change");

			const normalDetect = JSON.parse(
				runCli(["detect-release-pr", "--before", "v0.5.1", "--after", headBeforeRelease, "--pr-title", "feat(acp): second change"]),
			);
			expect(normalDetect.shouldRelease).toBe(false);

			const prepared = JSON.parse(runCli(["prepare", "--bump", "auto", "--from", "v0.5.1", "--date", "2026-11-19", "--write"]));
			expect(prepared.version).toBe("0.6.0");
			expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("0.6.0");
			expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toContain("## [0.6.0] - 2026-11-19");

			git("add", "package.json", "CHANGELOG.md");
			git("commit", "-m", "chore(release): v0.6.0");
			const releaseSha = git("rev-parse", "HEAD");

			const releaseDetect = JSON.parse(
				runCli([
					"detect-release-pr",
					"--before",
					headBeforeRelease,
					"--after",
					releaseSha,
					"--pr-title",
					"chore(release): v0.6.0",
					"--pr-branch",
					"release/v0.6.0",
				]),
			);
			expect(releaseDetect.shouldRelease).toBe(true);
			expect(releaseDetect.version).toBe("0.6.0");
			expect(releaseDetect.tag).toBe("v0.6.0");

			const extractedNotes = runCli(["notes", "--version", "0.6.0"]);
			expect(extractedNotes).toContain("**acp**: second change");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
