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

/** In-flight provisioning per HOME, so two callers in one process never race. */
const provisioning = new Map<string, Promise<void>>();

/**
 * Points one profile HOME's conversation artifacts at the shared store, carrying
 * over whatever that HOME already had. Running this twice is a no-op; a HOME that
 * already shares the store is left untouched.
 *
 * Callers serialize per HOME here because an ACP client can start several agents
 * at once; separate processes are covered by the tolerant steps below.
 */
export function linkSharedConversations(home: string, root?: string): Promise<void> {
	const key = `${home}\0${root ?? ""}`;
	const previous = provisioning.get(key) ?? Promise.resolve();
	const run = previous.then(() => provisionSharedConversations(home, root));
	const settled = run.catch(() => undefined);
	provisioning.set(key, settled);
	void settled.then(() => {
		if (provisioning.get(key) === settled) provisioning.delete(key);
	});
	return run;
}

async function provisionSharedConversations(home: string, root?: string): Promise<void> {
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

/** Staging names stay unique per process, so two provisioners never share one. */
let stagingCounter = 0;

/**
 * Links with a relative target so the whole root can be moved (as `~/.agy` was,
 * to `~/.agy-multi`) without leaving every profile HOME pointing at a path that
 * no longer exists. Windows junctions need an absolute target.
 */
async function linkToShared(link: string, source: string, dir: boolean): Promise<void> {
	if (await linkedTo(link, source)) return;
	const target = process.platform === "win32" ? source : relative(dirname(link), source);
	const kind = dir ? (process.platform === "win32" ? "junction" : "dir") : "file";
	await mkdir(dirname(link), { recursive: true });
	// Build the link beside its destination and rename it into place: `rename` is
	// atomic, so a concurrent provisioner of the same HOME never observes (or
	// trips over) a link that is still being created.
	const staging = join(dirname(link), `.${basename(link)}.${process.pid}.${stagingCounter++}.tmp`);
	await rm(staging, { force: true });
	await symlink(target, staging, kind);
	try {
		await rename(staging, link);
	} catch (error) {
		await rm(staging, { force: true });
		// Windows cannot replace an existing entry with a rename.
		if (!(await linkedTo(link, source))) throw error;
	}
}

/** True when `link` already resolves to the shared `source`. */
async function linkedTo(link: string, source: string): Promise<boolean> {
	const resolved = await realpath(link).catch(() => null);
	const expected = await realpath(source).catch(() => null);
	return Boolean(resolved && expected && resolved === expected);
}

/**
 * Moves a HOME's existing artifacts into the shared store. Returns `false` when
 * the path is deliberately pointed somewhere else and must not be hijacked.
 */
async function mergeIntoShared(link: string, source: string, shared: string): Promise<boolean> {
	const linkStat = await lstat(link).catch(() => null);
	if (!linkStat) return true;
	if (linkStat.isSymbolicLink()) {
		if (await linkedTo(link, source)) return true;
		// A dangling link has nothing to preserve, so it is ours to repoint.
		return (await realpath(link).catch(() => null)) === null;
	}

	const sourceStat = await lstat(source).catch(() => null);
	if (!sourceStat) {
		await mkdir(dirname(source), { recursive: true });
		await moveIntoShared(link, source);
		return true;
	}
	if (linkStat.isDirectory() && sourceStat.isDirectory()) {
		const names = await readdir(link).catch(() => []);
		for (const name of names) {
			const from = join(link, name);
			const to = join(source, name);
			if (await lstat(to).catch(() => null)) {
				// Two accounts wrote the same conversation id; keep the shared one
				// aside instead of deleting either.
				await quarantineIfPresent(from, shared);
				continue;
			}
			await moveIntoShared(from, to);
		}
		await rm(link, { recursive: true, force: true });
		return true;
	}
	if (linkStat.isFile() && sourceStat.isFile() && link.endsWith(".jsonl")) {
		// A peer may have appended and removed it first; appending nothing is correct.
		const content = await readFile(link).catch(() => null);
		if (content) await appendFile(source, content);
		await rm(link, { force: true });
		return true;
	}
	await quarantine(link, shared);
	return true;
}

/**
 * A concurrent provisioner of the same HOME may move the same artifact first,
 * which surfaces as ENOENT (source gone) or EEXIST/ENOTEMPTY (destination already
 * holds it). Both leave the artifact in the shared store, which is the point.
 */
async function moveIntoShared(from: string, to: string): Promise<void> {
	try {
		await rename(from, to);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
	}
}

/** Quarantines a collision unless a peer already moved the artifact away. */
async function quarantineIfPresent(path: string, shared: string): Promise<void> {
	if (!(await lstat(path).catch(() => null))) return;
	await quarantine(path, shared);
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
