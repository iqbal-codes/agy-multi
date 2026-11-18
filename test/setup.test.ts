import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAgy } from "../src/setup";

// The helper falls back to a network install when it cannot find a binary, so
// the test pins AGY_BIN instead of trusting whatever the runner has on PATH.
const previousBin = process.env.AGY_BIN;

afterEach(() => {
	if (previousBin === undefined) delete process.env.AGY_BIN;
	else process.env.AGY_BIN = previousBin;
});

describe("ensureAgy helper", () => {
	test("returns the configured agy executable without installing anything", async () => {
		const root = await mkdtemp(join(tmpdir(), "agy-ensure-"));
		const bin = join(root, "agy");
		await writeFile(bin, "#!/bin/sh\nexit 0\n");
		await chmod(bin, 0o755);
		process.env.AGY_BIN = bin;
		try {
			expect(await ensureAgy()).toBe(bin);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 10_000);
});
