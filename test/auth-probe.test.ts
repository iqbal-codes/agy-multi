import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { symlinkIfMissing } from "../src/fs-utils";
import { hasValidAuth } from "../src/profile";
import { profileHome } from "../src/paths";
import type { Profile } from "../src/types";

const profileOf = (slug: string): Profile => ({ slug, createdAt: "now" });

async function withFile(slug: string, relativePath: string, content = "x"): Promise<void> {
	const target = join(profileHome(slug), relativePath);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, content);
}

describe("hasValidAuth", () => {
	test("a stored token file is enough", async () => {
		const slug = "auth-token-file";
		await withFile(slug, ".gemini/antigravity-cli/antigravity-oauth-token");
		try {
			expect(await hasValidAuth(profileOf(slug))).toBe(true);
		} finally {
			await rm(profileHome(slug), { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "darwin")(
		"an isolated keychain counts as credentials without asking macOS",
		async () => {
			const slug = "auth-keychain-only";
			// A bogus keychain file: `security` would reject it, but the check must not
			// shell out at all, because that is what raises the password prompt.
			await withFile(slug, "Library/Keychains/login.keychain-db", "not a real keychain");
			try {
				expect(await hasValidAuth(profileOf(slug))).toBe(true);
			} finally {
				await rm(profileHome(slug), { recursive: true, force: true });
			}
		},
	);
	test("no token and no keychain means signed out", async () => {
		const slug = "auth-empty";
		try {
			expect(await hasValidAuth(profileOf(slug))).toBe(false);
		} finally {
			await rm(profileHome(slug), { recursive: true, force: true });
		}
	});
	test("an adopted profile relies on the system keychain", async () => {
		expect(await hasValidAuth({ slug: "auth-adopted", createdAt: "now", home: "/tmp" })).toBe(true);
	});

	test("profile sync surfaces missing credentials instead of silently reporting quota unavailable", async () => {
		const root = await mkdtemp(join(tmpdir(), "agy-sync-missing-auth-"));
		const projectRoot = join(import.meta.dir, "..");
		try {
			const dir = join(root, "profiles", "signed-out");
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "profile.json"), JSON.stringify({ slug: "signed-out", createdAt: "now" }));
			await writeFile(
				join(dir, "usage.json"),
				JSON.stringify({
					profile: "signed-out",
					fetchedAt: Date.now() - 60 * 60_000,
					windows: [{ family: "gemini", window: "weekly", remainingPct: 87, resetsAt: "2099-01-01T00:00:00Z" }],
					raw: "",
				}),
			);
			const proc = Bun.spawn([process.execPath, join(projectRoot, "src/index.ts"), "profile", "sync", "signed-out"], {
				cwd: projectRoot,
				env: { ...process.env, AGY_MULTI_ROOT: root },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			expect(await proc.exited, stderr).toBe(0);
			expect(stdout).toContain("auth: missing (run `agy-multi profile login signed-out`)");
			expect(stdout).toContain("quota: cached (gemini weekly 87%");
			expect(stdout).toContain("1h old");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe.skipIf(process.platform === "win32")("symlinkIfMissing", () => {
	test("replaces a broken symlink when the new source exists, without touching valid links or files", async () => {
		const root = await mkdtemp(join(tmpdir(), "agy-symlink-heal-"));
		try {
			const src = join(root, "real-source");
			const brokenLink = join(root, "broken");
			const validLink = join(root, "valid");
			const regularFile = join(root, "regular");
			await writeFile(src, "ok");
			await writeFile(regularFile, "keep");
			await symlink(join(root, "missing-old-home"), brokenLink);
			await symlink(src, validLink);

			expect(await symlinkIfMissing(brokenLink, src)).toBe(true);
			expect(await readlink(brokenLink)).toBe(src);
			expect(await symlinkIfMissing(validLink, src)).toBe(false);
			expect(await symlinkIfMissing(regularFile, src)).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe.skipIf(process.platform === "win32")("profile login browser suppression", () => {
	test("blocks xdg-open auto-launch so login never opens a fresh browser profile", async () => {
		const root = await mkdtemp(join(tmpdir(), "agy-login-nobrowser-"));
		const projectRoot = join(import.meta.dir, "..");
		const fakeBinDir = join(root, "fake-system-bin");
		const openedMarker = join(root, "browser-opened");
		const fakeAgy = join(root, "fake-agy");
		try {
			await mkdir(fakeBinDir, { recursive: true });
			await mkdir(join(root, "profiles", "acct"), { recursive: true });
			await writeFile(join(root, "profiles", "acct", "profile.json"), JSON.stringify({ slug: "acct", createdAt: "now" }));
			// Fake system xdg-open that marks if anything bypassed the shim.
			const fakeXdg = join(fakeBinDir, "xdg-open");
			await writeFile(fakeXdg, `#!/bin/sh\necho opened > ${JSON.stringify(openedMarker)}\n`);
			await chmod(fakeXdg, 0o755);
			// Fake agy CLI that tries calling xdg-open during --login like real agy does.
			await writeFile(
				fakeAgy,
				[
					"#!/usr/bin/env bun",
					'import { writeFileSync } from "node:fs";',
					'if (process.argv.includes("--login")) {',
					'  Bun.spawnSync(["xdg-open", "https://accounts.google.com/o/oauth2/auth"]);',
					'  const at = process.argv.indexOf("--log-file");',
					'  if (at >= 0) writeFileSync(process.argv[at + 1], "applyAuthResult: email=manual@example.com, authMethod=consumer\\n");',
					"  process.exit(0);",
					"}",
					"process.exit(0);",
					"",
				].join("\n"),
			);
			await chmod(fakeAgy, 0o755);

			const proc = Bun.spawn(
				[process.execPath, join(projectRoot, "src/index.ts"), "profile", "login", "acct", "--no-canary"],
				{
					cwd: projectRoot,
					env: {
						...process.env,
						AGY_MULTI_ROOT: root,
						AGY_BIN: fakeAgy,
						PATH: `${fakeBinDir}${delimiter}${process.env.PATH ?? ""}`,
					},
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			expect(await proc.exited, stderr).toBe(0);
			expect(stdout).toContain("logged in acct\tmanual@example.com");
			expect(await Bun.file(openedMarker).exists()).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
