import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const projectRoot = join(import.meta.dir, "..");

async function security(...args: string[]): Promise<void> {
	const proc = Bun.spawn(["/usr/bin/security", ...args], {
		stdin: "ignore", stdout: "ignore", stderr: "pipe",
	});
	const stderr = await new Response(proc.stderr).text();
	if (await proc.exited !== 0) throw new Error(`security ${args[0]} failed: ${stderr.trim()}`);
}

async function fixture(password?: string, withItem = false) {
	const root = await mkdtemp(join(tmpdir(), "agy-multi-keychain-"));
	const dir = join(root, "profiles", "locked-profile");
	const keychain = join(dir, "home", "Library", "Keychains", "login.keychain-db");
	const backingKeychain = join(dir, "home", "Library", "Keychains", "agy-multi.keychain-db");
	await mkdir(join(dir, "home", "Library", "Keychains"), { recursive: true });
	await writeFile(join(dir, "profile.json"), JSON.stringify({
		slug: "locked-profile", createdAt: new Date().toISOString(),
	}));
	if (password !== undefined) {
		await security("create-keychain", "-p", password, keychain);
		if (withItem) {
			await security("add-generic-password", "-s", "agy-multi-regression", "-a", "test", "-w", "test-only-value", keychain);
		}
		await security("lock-keychain", keychain);
	}
	return {
		root, keychain, backingKeychain,
		async cleanup() {
			if (await Bun.file(keychain).exists()) await security("delete-keychain", keychain);
			if (await Bun.file(backingKeychain).exists()) await security("delete-keychain", backingKeychain);
			await rm(root, { recursive: true, force: true });
		},
	};
}

async function cli(root: string, entry: string, args: string[]) {
	const proc = Bun.spawn([process.execPath, join(projectRoot, entry), ...args], {
		cwd: projectRoot,
		env: {
			...process.env,
			AGY_MULTI_ROOT: root,
			AGY_BIN: process.env.AGY_BIN ?? "/usr/bin/true",
		},
		detached: true,
		stdin: "ignore", stdout: "pipe", stderr: "pipe",
	});
	let timedOut = false;
	const timeoutMs = process.env.CI ? 10_000 : 4_000;
	const timer = setTimeout(() => {
		timedOut = true;
		// Include security subprocesses so a regression cannot leave a dialog waiting.
		process.kill(-proc.pid, "SIGKILL");
	}, timeoutMs);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
		]);
		expect(timedOut, "keychain preparation must not wait for GUI interaction").toBe(false);
		return { stdout, stderr, exitCode };
	} finally {
		clearTimeout(timer);
	}
}

describe.skipIf(process.platform !== "darwin")("macOS profile keychain integration", () => {
	test("sync unlocks an existing locked keychain before changing settings, including after relock", async () => {
		const f = await fixture("", true);
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				const result = await cli(f.root, "src/index.ts", ["profile", "sync", "locked-profile"]);
				expect(result.exitCode, result.stderr).toBe(0);
				expect(result.stdout).toContain("synced locked-profile");
				expect((await lstat(f.keychain)).isSymbolicLink()).toBe(true);
				await security("find-generic-password", "-s", "agy-multi-regression", "-a", "test", f.keychain);
				await security("show-keychain-info", f.keychain);
				await security("lock-keychain", f.keychain);
			}
		} finally {
			await f.cleanup();
		}
	});

	for (const [entry, args] of [["src/index.ts", ["acp"]], ["src/acp-bin.ts", []]] as const) {
		test(`${entry} starts ACP with a locked profile keychain`, async () => {
			const f = await fixture("");
			try {
				const result = await cli(f.root, entry, [...args]);
				expect(result.exitCode, result.stderr).toBe(0);
				expect(result.stderr).toContain("ready — 1 profile(s)");
			} finally {
				await f.cleanup();
			}
		});
	}

	test("sync provisions a new keychain", async () => {
		const f = await fixture();
		try {
			const result = await cli(f.root, "src/index.ts", ["profile", "sync", "locked-profile"]);
			expect(result.exitCode, result.stderr).toBe(0);
			expect(await Bun.file(f.keychain).exists()).toBe(true);
			await security("show-keychain-info", f.keychain);
		} finally {
			await f.cleanup();
		}
	});

	for (const [name, entry, args] of [
		["profile sync", "src/index.ts", ["profile", "sync", "locked-profile"]],
		["ACP command", "src/index.ts", ["acp"]],
		["ACP entrypoint", "src/acp-bin.ts", []],
	] as const) {
		test(`${name} rejects an unlock failure without prompting or silently continuing`, async () => {
			const f = await fixture("test-only-nonempty-password");
			try {
				const result = await cli(f.root, entry, [...args]);
				expect(result.exitCode).not.toBe(0);
				expect(result.stderr).toContain("unlock-keychain");
				expect(result.stderr).toContain(f.backingKeychain);
			} finally {
				await f.cleanup();
			}
		});
	}
});
