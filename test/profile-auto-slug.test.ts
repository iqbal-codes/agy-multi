import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextAccountSlug } from "../src/profile";
import { saveProfile } from "../src/registry";

describe("auto-generated profile slugs", () => {
	let root: string;
	let previousRoot: string | undefined;

	beforeEach(async () => {
		previousRoot = process.env.AGY_MULTI_ROOT;
		root = await mkdtemp(join(tmpdir(), "agy-auto-slug-"));
		process.env.AGY_MULTI_ROOT = root;
	});

	afterEach(async () => {
		if (previousRoot === undefined) delete process.env.AGY_MULTI_ROOT;
		else process.env.AGY_MULTI_ROOT = previousRoot;
		await rm(root, { recursive: true, force: true });
	});

	const register = (slug: string) => saveProfile({ slug, createdAt: "2026-11-25T00:00:00Z" });

	it("starts at account-1 when no accounts exist", async () => {
		expect(await nextAccountSlug()).toBe("account-1");
	});

	it("continues past the highest existing account number", async () => {
		await register("account-1");
		await register("account-3");
		expect(await nextAccountSlug()).toBe("account-4");
	});

	it("ignores manually named profiles", async () => {
		await register("work");
		await register("backup");
		expect(await nextAccountSlug()).toBe("account-1");
	});

	it("skips an orphaned profile directory without metadata", async () => {
		await register("account-1");
		await mkdir(join(root, "profiles", "account-2", "home"), { recursive: true });
		expect(await nextAccountSlug()).toBe("account-3");
	});
});
