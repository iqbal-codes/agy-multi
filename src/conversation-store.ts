import { appendFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { ROOT } from "./paths";

interface ConversationEntry {
	/** Path inside the profile HOME. */
	path: string;
	/** Whether `agy` writes a directory or a single file. */
	dir: boolean;
}

/**
 * What makes a conversation resumable in `agy`. Everything else in the profile
 * HOME — credentials, accounts, settings, caches, logs — stays per account:
 * switching accounts should move the conversation, not the identity.
 */
const CONVERSATION_ENTRIES: ConversationEntry[] = [
	{ path: ".gemini/antigravity-cli/brain", dir: true },
	{ path: ".gemini/antigravity-cli/conversations", dir: true },
	{ path: ".gemini/antigravity-cli/history.jsonl", dir: false },
];

/** Shared store every profile HOME links its conversation artifacts to. */
export function sharedConversationsRoot(root = process.env.AGY_MULTI_ROOT || ROOT): string {
	return join(root, "shared", "gemini");
}

/**
 * Points one profile HOME's conversation artifacts at the shared store, carrying
 * over whatever that HOME already had. Running this twice is a no-op; a HOME that
 * already shares the store is left untouched.
 */
export async function linkSharedConversations(home: string, root?: string): Promise<void> {
	const shared = sharedConversationsRoot(root);
	for (const entry of CONVERSATION_ENTRIES) {
		const source = join(shared, entry.path.replace(/^\.gemini\//, ""));
		const link = join(home, entry.path);
		if (!(await mergeIntoShared(link, source, shared))) continue;
		if (entry.dir) {
			await mkdir(source, { recursive: true });
		} else {
			await mkdir(dirname(source), { recursive: true });
			await writeFile(source, "", { flag: "a" });
		}
		await linkToShared(link, source, entry.dir);
	}
}

/**
 * Links with a relative target so the whole root can be moved (as `~/.agy` was,
 * to `~/.agy-multi`) without leaving every profile HOME pointing at a path that
 * no longer exists. Windows junctions need an absolute target.
 */
async function linkToShared(link: string, source: string, dir: boolean): Promise<void> {
	const existing = await lstat(link).catch(() => null);
	if (existing?.isSymbolicLink()) {
		const resolved = await realpath(link).catch(() => null);
		const expected = await realpath(source).catch(() => null);
		if (resolved && expected && resolved === expected) return;
	}
	await mkdir(dirname(link), { recursive: true });
	await rm(link, { recursive: true, force: true });
	const target = process.platform === "win32" ? source : relative(dirname(link), source);
	await symlink(target, link, dir ? (process.platform === "win32" ? "junction" : "dir") : "file");
}

/**
 * Moves a HOME's existing artifacts into the shared store. Returns `false` when
 * the path is deliberately pointed somewhere else and must not be hijacked.
 */
async function mergeIntoShared(link: string, source: string, shared: string): Promise<boolean> {
	const linkStat = await lstat(link).catch(() => null);
	if (!linkStat) return true;
	if (linkStat.isSymbolicLink()) {
		const current = await realpath(link).catch(() => null);
		const expected = await realpath(source).catch(() => null);
		if (current && expected && current === expected) return true;
		// A dangling link has nothing to preserve, so it is ours to repoint.
		if (!current) return true;
		return false;
	}

	const sourceStat = await lstat(source).catch(() => null);
	if (!sourceStat) {
		await mkdir(dirname(source), { recursive: true });
		await rename(link, source);
		return true;
	}
	if (linkStat.isDirectory() && sourceStat.isDirectory()) {
		for (const name of await readdir(link)) {
			const from = join(link, name);
			const to = join(source, name);
			if (await lstat(to).catch(() => null)) {
				// Two accounts wrote the same conversation id; keep the shared one
				// aside instead of deleting either.
				await quarantine(from, shared);
				continue;
			}
			await rename(from, to);
		}
		await rm(link, { recursive: true, force: true });
		return true;
	}
	if (linkStat.isFile() && sourceStat.isFile() && link.endsWith(".jsonl")) {
		await appendFile(source, await readFile(link));
		await rm(link, { force: true });
		return true;
	}
	await quarantine(link, shared);
	return true;
}

/** Preserves an artifact that cannot be merged, instead of dropping it. */
async function quarantine(path: string, shared: string): Promise<void> {
	const base = join(shared, "migrated");
	await mkdir(base, { recursive: true });
	const name = basename(path);
	let destination = join(base, name);
	for (let index = 2; await lstat(destination).catch(() => null); index++) {
		destination = join(base, `${name}.${index}`);
	}
	await rename(path, destination);
}
