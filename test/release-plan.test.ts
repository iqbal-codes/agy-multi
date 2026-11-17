import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	compareVersions,
	deriveBump,
	nextVersion,
	parseVersion,
	pickBump,
	releaseBase,
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
});
