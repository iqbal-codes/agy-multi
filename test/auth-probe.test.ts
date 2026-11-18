import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
});
