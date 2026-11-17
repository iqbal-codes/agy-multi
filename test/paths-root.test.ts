import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");
const PROBE = "import { ROOT } from './src/paths.ts'; console.log(ROOT);";

/** Imports the real paths module in a child process so HOME can be faked. */
function resolveRoot(home: string, extra: Record<string, string> = {}): string {
	const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, ...extra };
	if (!Object.hasOwn(extra, "AGY_MULTI_ROOT")) delete env.AGY_MULTI_ROOT;
	const proc = Bun.spawnSync({
		cmd: [process.execPath, "-e", PROBE],
		cwd: projectRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) throw new Error(`probe failed: ${proc.stderr.toString()}`);
	return proc.stdout.toString().trim();
}

describe("state root", () => {
	test("moves a legacy ~/.agy root to ~/.agy-multi once", async () => {
		const home = await mkdtemp(join(tmpdir(), "agy-home-"));
		const legacy = join(home, ".agy");
		await mkdir(join(legacy, "profiles", "work"), { recursive: true });
		await writeFile(join(legacy, "profiles", "work", "profile.json"), "{}");

		expect(resolveRoot(home)).toBe(join(home, ".agy-multi"));
		expect(await readFile(join(home, ".agy-multi", "profiles", "work", "profile.json"), "utf8")).toBe("{}");
		expect(existsSync(legacy)).toBe(false);
	});

	test("leaves an existing new root alone", async () => {
		const home = await mkdtemp(join(tmpdir(), "agy-home-"));
		await mkdir(join(home, ".agy-multi", "profiles"), { recursive: true });
		await mkdir(join(home, ".agy", "profiles"), { recursive: true });

		expect(resolveRoot(home)).toBe(join(home, ".agy-multi"));
		// Both stay in place: nothing is merged behind the user's back.
		expect(existsSync(join(home, ".agy", "profiles"))).toBe(true);
	});

	test("ignores a ~/.agy that is not an agy-multi root", async () => {
		const home = await mkdtemp(join(tmpdir(), "agy-home-"));
		await mkdir(join(home, ".agy", "something-else"), { recursive: true });

		expect(resolveRoot(home)).toBe(join(home, ".agy-multi"));
		expect(existsSync(join(home, ".agy", "something-else"))).toBe(true);
	});

	test("honours an explicit root without moving anything", async () => {
		const home = await mkdtemp(join(tmpdir(), "agy-home-"));
		await mkdir(join(home, ".agy", "profiles"), { recursive: true });
		const custom = join(home, "custom-root");

		expect(resolveRoot(home, { AGY_MULTI_ROOT: custom })).toBe(custom);
		expect(existsSync(join(home, ".agy", "profiles"))).toBe(true);
	});
});
