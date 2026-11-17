/**
 * Release planning shared by the PR workflow (what a merge *will* publish) and
 * the release workflow (what it *does* publish), so the projection in the pull
 * request cannot drift from the tag that lands on main.
 */

export type ReleaseBump = "patch" | "minor" | "major";

const CONVENTIONAL_TITLE = /^([a-z]+)(?:\([^)]*\))?(!)?:/i;

/**
 * Conventional-commit title → semver bump. `feat:` is a feature, `feat!:` or a
 * `BREAKING CHANGE:` footer is a break, everything else is a patch: docs and
 * chores still ship, they just do not claim a new capability.
 *
 * The footer has to start a line, as the convention requires. Prose that merely
 * mentions a breaking change must not bump the major digit.
 */
export function deriveBump(title: string, body = ""): ReleaseBump {
	if (/^BREAKING[ -]CHANGE:/im.test(body)) return "major";
	const match = CONVENTIONAL_TITLE.exec(title.trim());
	if (!match) return "patch";
	if (match[2]) return "major";
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

function normalize(value: string): string {
	const [major, minor, patch] = parseVersion(value);
	return `${major}.${minor}.${patch}`;
}

function flag(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
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
	} else {
		console.error(
			"usage: release-plan.ts derive <title> [body] | pick <input> <labels> <commit> | base <package> [tag] | next <base> <bump> | resolve --package <v> [--tag <v>] [--bump <bump>]",
		);
		process.exit(1);
	}
}
