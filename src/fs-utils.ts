import { copyFile, link, mkdir, readFile, rename, stat, symlink, lstat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJson<T>(path: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(tmp, path);
}

export async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

export async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** Link `source` at `target` only when the source exists and the target does not. */
export async function symlinkIfMissing(target: string, source: string): Promise<boolean> {
	if (await exists(target)) return false;
	try {
		await stat(source);
	} catch {
		return false;
	}
	await mkdir(dirname(target), { recursive: true });
	const sourceStat = await stat(source);
	if (sourceStat.isDirectory()) {
		await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
	} else {
		try {
			await symlink(source, target, "file");
		} catch (err: unknown) {
			const code = (err as { code?: string })?.code;
			if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
				try {
					await link(source, target);
				} catch {
					await copyFile(source, target);
				}
			} else {
				throw err;
			}
		}
	}
	return true;
}

export async function run(
	cmd: string[],
	options: { env?: Record<string, string | undefined>; cwd?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, {
		env: { ...process.env, ...options.env },
		cwd: options.cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}
