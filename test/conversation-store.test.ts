import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { linkSharedConversations } from "../src/conversation-store";

async function seedHome(root: string, name: string, files: Record<string, string>): Promise<string> {
	const home = join(root, "profiles", name, "home");
	await mkdir(home, { recursive: true });
	for (const [relative, content] of Object.entries(files)) {
		const path = join(home, relative);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content);
	}
	return home;
}

describe("shared conversation store", () => {
	test("shares conversations across accounts and leaves credentials per account", async () => {
		const root = await mkdtemp(join(tmpdir(), "agy-store-"));
		const a = await seedHome(root, "a", {
			".gemini/antigravity-cli/brain/conv-1/transcript.jsonl": "TURN_A\n",
			".gemini/antigravity-cli/conversations/conv-1.db": "DB_A",
			".gemini/antigravity-cli/history.jsonl": "HISTORY_A\n",
			".gemini/oauth_creds.json": "CREDS_A",
		});
		const b = await seedHome(root, "b", {
			".gemini/antigravity-cli/history.jsonl": "HISTORY_B\n",
			".gemini/oauth_creds.json": "CREDS_B",
		});

		await linkSharedConversations(a, root);
		await linkSharedConversations(b, root);

		// One conversation, reachable from either HOME.
		const transcript = ".gemini/antigravity-cli/brain/conv-1/transcript.jsonl";
		expect(await readFile(join(b, transcript), "utf8")).toBe("TURN_A\n");
		expect(await readFile(join(a, transcript), "utf8")).toBe("TURN_A\n");
		expect(await realpath(join(a, ".gemini/antigravity-cli/conversations"))).toBe(
			await realpath(join(b, ".gemini/antigravity-cli/conversations")),
		);
		// Append-only history from both accounts lands in the same file.
		expect(await readFile(join(a, ".gemini/antigravity-cli/history.jsonl"), "utf8")).toBe("HISTORY_A\nHISTORY_B\n");

		// Credentials stay separate regular files in each HOME.
		for (const [home, creds] of [
			[a, "CREDS_A"],
			[b, "CREDS_B"],
		] as const) {
			const path = join(home, ".gemini/oauth_creds.json");
			expect((await lstat(path)).isSymbolicLink()).toBe(false);
			expect(await readFile(path, "utf8")).toBe(creds);
		}
	});

	test("is idempotent and quarantines a colliding conversation", async () => {
		const root = await mkdtemp(join(tmpdir(), "agy-store-"));
		const a = await seedHome(root, "a", { ".gemini/antigravity-cli/conversations/conv-1.db": "DB_A" });
		const b = await seedHome(root, "b", { ".gemini/antigravity-cli/conversations/conv-1.db": "DB_B" });

		await linkSharedConversations(a, root);
		await linkSharedConversations(b, root);
		await linkSharedConversations(b, root);

		const shared = join(root, "shared", "gemini", "antigravity-cli", "conversations", "conv-1.db");
		expect(await readFile(shared, "utf8")).toBe("DB_A");
		// The losing copy is preserved, not deleted.
		expect(await readdir(join(root, "shared", "gemini", "migrated"))).toContain("conv-1.db");
	});

	test("provisions the same HOME concurrently without failing", async () => {
		const root = await mkdtemp(join(tmpdir(), "agy-store-"));
		const a = await seedHome(root, "a", {
			".gemini/antigravity-cli/brain/conv-1/transcript.jsonl": "TURN_A\n",
			".gemini/antigravity-cli/conversations/conv-1.db": "DB_A",
		});

		// Every agent process provisions every profile HOME, and a client may start
		// several agents at once: the same HOME must not provision twice into a
		// half-moved state (ENOENT/EEXIST) that kills the process.
		await Promise.all([linkSharedConversations(a, root), linkSharedConversations(a, root), linkSharedConversations(a, root)]);

		expect(await readFile(join(a, ".gemini/antigravity-cli/brain/conv-1/transcript.jsonl"), "utf8")).toBe("TURN_A\n");
		expect(await realpath(join(a, ".gemini/antigravity-cli/conversations"))).toBe(
			await realpath(join(root, "shared", "gemini", "antigravity-cli", "conversations")),
		);
	});

	test("relative links survive moving the whole root", async () => {
		const root = await mkdtemp(join(tmpdir(), "agy-store-"));
		const a = await seedHome(root, "a", { ".gemini/antigravity-cli/brain/conv-1/transcript.jsonl": "TURN_A\n" });
		await linkSharedConversations(a, root);

		const link = join(a, ".gemini/antigravity-cli/brain");
		expect((await readlink(link)).startsWith("/")).toBe(false);

		const moved = `${root}-moved`;
		await rename(root, moved);
		expect(
			await readFile(join(moved, "profiles/a/home/.gemini/antigravity-cli/brain/conv-1/transcript.jsonl"), "utf8"),
		).toBe("TURN_A\n");
	});
});
