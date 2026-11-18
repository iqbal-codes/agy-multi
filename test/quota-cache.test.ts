import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const SNAPSHOT = {
	profile: "acct",
	fetchedAt: Date.parse("2026-11-18T06:00:00Z"),
	windows: [
		{ family: "gemini", window: "weekly", remainingPct: 94, resetsAt: "2026-11-21T03:11:35Z" },
		{ family: "gemini", window: "fiveHour", remainingPct: 99, resetsAt: "2026-11-18T01:10:41Z" },
	],
	raw: "",
};

/**
 * The CLI binary here is a trap: it drops a marker the moment anything spawns
 * it. `quota` reads the cache, so the marker must stay absent.
 */
async function fixture(options: { cached: boolean }) {
	const root = await mkdtemp(join(tmpdir(), "agy-quota-cache-"));
	await mkdir(join(root, "profiles/acct"), { recursive: true });
	await mkdir(join(root, "home-acct"), { recursive: true });
	await writeFile(
		join(root, "profiles/acct/profile.json"),
		JSON.stringify({ slug: "acct", home: join(root, "home-acct"), createdAt: "now" }),
	);
	if (options.cached) {
		await writeFile(join(root, "profiles/acct/usage.json"), JSON.stringify(SNAPSHOT));
	}
	const marker = join(root, "cli-spawned");
	const bin = join(root, "agy-trap");
	await writeFile(bin, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
	await chmod(bin, 0o755);
	return { root, marker, bin };
}

async function runCommand(context: { root: string; bin: string }, args: string[]) {
	const proc = Bun.spawn([process.execPath, join(REPO, "src/index.ts"), ...args], {
		env: { ...process.env, AGY_MULTI_ROOT: context.root, AGY_BIN: context.bin, HOME: context.root },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

describe("quota reads the cache", () => {
	test("prints the cached snapshot without spawning the CLI", async () => {
		const context = await fixture({ cached: true });
		try {
			const result = await runCommand(context, ["quota"]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("acct\tgemini\tweekly\t94%\t2026-11-21T03:11:35Z");
			expect(result.stdout).toContain("acct\tgemini\tfiveHour\t99%\t2026-11-18T01:10:41Z");
			expect(result.stderr).toContain("# cached");
			expect(existsSync(context.marker)).toBe(false);
		} finally {
			await rm(context.root, { recursive: true, force: true });
		}
	});

	test("multi-usage reports the same cached numbers without spawning the CLI", async () => {
		const context = await fixture({ cached: true });
		try {
			const result = await runCommand(context, ["multi-usage"]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Weekly Limit Remaining");
			expect(existsSync(context.marker)).toBe(false);
		} finally {
			await rm(context.root, { recursive: true, force: true });
		}
	});

	test("a cold cache says so instead of quietly probing", async () => {
		const context = await fixture({ cached: false });
		try {
			const result = await runCommand(context, ["quota"]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("acct\t(no cached usage; run with --refresh)");
			expect(existsSync(context.marker)).toBe(false);
		} finally {
			await rm(context.root, { recursive: true, force: true });
		}
	}, 20_000);
});
