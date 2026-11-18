import { chmod, copyFile, mkdir, mkdtemp, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { compareVersions } from "./release-plan";
import { VERSION } from "./version";

/**
 * `agy-multi update` — self-update from the published GitHub release.
 *
 * The update is only as trustworthy as what it installs, so it fails closed at
 * every step that could leave a broken install: the archive must match the
 * release's SHA-256, the extracted binary must report the release's version
 * before anything is replaced, and only then are the two installed binaries
 * swapped in with same-directory renames (atomic on POSIX, and a running
 * process keeps its old inode). State under `~/.agy-multi` is never touched.
 */

/** GitHub repository that publishes the prebuilt binaries. */
export const DEFAULT_REPO_SLUG = "iqbal-codes/agy-multi";
const GITHUB_API = "https://api.github.com";
const USER_AGENT = "agy-multi-updater";
/** Filenames the release workflow packages, per target. */
const BINARIES = ["agy-multi", "agy-multi-acp"] as const;

export interface ReleaseAsset {
	name: string;
	url: string;
	size: number;
	/** GitHub's `sha256:<hex>` digest, when the release publishes one. */
	digest?: string;
}

export interface ReleaseInfo {
	tag: string;
	/** `tag` without the leading `v`. */
	version: string;
	assets: ReleaseAsset[];
}

export interface ReleaseSource {
	repoSlug?: string;
	apiBase?: string;
	token?: string | null;
	fetchImpl?: typeof fetch;
}

interface GitHubAsset {
	name?: string;
	browser_download_url?: string;
	size?: number;
	digest?: string | null;
}

interface GitHubRelease {
	tag_name?: string;
	assets?: GitHubAsset[];
}

interface ResolvedSource {
	repoSlug: string;
	apiBase: string;
	token: string | null;
	fetchImpl: typeof fetch;
}

function resolveSource(source: ReleaseSource = {}): ResolvedSource {
	return {
		repoSlug: source.repoSlug ?? process.env.AGY_MULTI_REPO_SLUG ?? DEFAULT_REPO_SLUG,
		apiBase: (source.apiBase ?? process.env.AGY_MULTI_GITHUB_API ?? GITHUB_API).replace(/\/+$/, ""),
		token: source.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null,
		fetchImpl: source.fetchImpl ?? fetch,
	};
}

function requestHeaders(token: string | null): Record<string, string> {
	return {
		"user-agent": USER_AGENT,
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};
}

/** `<os>-<arch>` as the release assets spell it: darwin-arm64, linux-x64, windows-x64. */
export function platformKey(platform: string = process.platform, arch: string = process.arch): string {
	const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : "";
	if (!os) throw new Error(`agy-multi publishes no binary for ${platform}; build it from source (bun run build)`);
	if (arch !== "x64" && arch !== "arm64") {
		throw new Error(`agy-multi publishes no binary for ${os}-${arch}; build it from source (bun run build)`);
	}
	return `${os}-${arch}`;
}

/** The archive for `platform`, found in the release rather than guessed from a URL template. */
export function selectAsset(release: ReleaseInfo, platform: string): ReleaseAsset {
	for (const name of [`agy-multi-${platform}.tar.gz`, `agy-multi-${platform}.zip`]) {
		const asset = release.assets.find(candidate => candidate.name === name);
		if (asset) return asset;
	}
	const published = release.assets.map(asset => asset.name).join(", ") || "none";
	throw new Error(`release ${release.tag} has no binary for ${platform} (published: ${published})`);
}

/** `<sha256>  <name>` lines, as `sha256sum` writes them; `*` marks binary mode. */
export function parseChecksums(text: string): Map<string, string> {
	const sums = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
		if (match?.[1] && match[2]) sums.set(match[2], match[1].toLowerCase());
	}
	return sums;
}

export async function fetchLatestRelease(source: ReleaseSource = {}): Promise<ReleaseInfo> {
	const { repoSlug, apiBase, token, fetchImpl } = resolveSource(source);
	const response = await fetchImpl(`${apiBase}/repos/${repoSlug}/releases/latest`, {
		headers: {
			...requestHeaders(token),
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
		},
	});
	if (response.status === 404) throw new Error(`no published release for ${repoSlug}`);
	if (response.status === 403 || response.status === 429) {
		throw new Error(
			`GitHub refused the release lookup (${response.status}); set GITHUB_TOKEN to raise the rate limit, then retry`,
		);
	}
	if (!response.ok) {
		throw new Error(`release lookup failed: ${response.status} ${response.statusText} (${apiBase}/repos/${repoSlug})`);
	}

	const payload = (await response.json()) as GitHubRelease;
	const tag = payload.tag_name?.trim();
	if (!tag) throw new Error(`release metadata for ${repoSlug} carried no tag`);
	const assets = (payload.assets ?? [])
		.filter(
			(asset): asset is GitHubAsset & { name: string; browser_download_url: string } =>
				Boolean(asset.name && asset.browser_download_url),
		)
		.map(asset => ({
			name: asset.name,
			url: asset.browser_download_url,
			size: asset.size ?? 0,
			...(asset.digest ? { digest: asset.digest } : {}),
		}));
	return { tag, version: tag.replace(/^v/i, ""), assets };
}

/** Where the currently running binary lives, with symlinks resolved. */
async function installDirOf(execPath: string): Promise<string> {
	const resolved = await realpath(execPath).catch(() => execPath);
	return dirname(resolved);
}

/** A compiled single-file binary embeds its sources under Bun's `$bunfs` mount. */
export function isCompiledBinary(): boolean {
	return import.meta.url.includes("$bunfs");
}

/** The archive's checksum: GitHub's own digest first, the release's SHA256SUMS.txt otherwise. */
async function expectedChecksum(
	release: ReleaseInfo,
	asset: ReleaseAsset,
	source: ReleaseSource = {},
): Promise<string> {
	if (asset.digest?.startsWith("sha256:")) return asset.digest.slice("sha256:".length).toLowerCase();
	const sums = release.assets.find(candidate => candidate.name === "SHA256SUMS.txt");
	if (!sums) {
		throw new Error(`release ${release.tag} publishes no checksum for ${asset.name}; refusing to install unverified bytes`);
	}
	const { token, fetchImpl } = resolveSource(source);
	const response = await fetchImpl(sums.url, { headers: requestHeaders(token) });
	if (!response.ok) throw new Error(`could not read SHA256SUMS.txt (${response.status} ${response.statusText})`);
	const digest = parseChecksums(await response.text()).get(asset.name);
	if (!digest) throw new Error(`SHA256SUMS.txt in release ${release.tag} does not cover ${asset.name}`);
	return digest;
}

/** Streams the archive to disk and hashes it in the same pass, so 100 MB never sits in memory. */
async function downloadArchive(path: string, asset: ReleaseAsset, source: ReleaseSource = {}): Promise<string> {
	const { token, fetchImpl } = resolveSource(source);
	const response = await fetchImpl(asset.url, { headers: requestHeaders(token) });
	if (!response.ok || !response.body) {
		throw new Error(`download of ${asset.name} failed: ${response.status} ${response.statusText}`);
	}

	const total = Number(response.headers.get("content-length") ?? "") || asset.size;
	const sink = Bun.file(path).writer();
	const hasher = new Bun.CryptoHasher("sha256");
	const showProgress = Boolean(process.stderr.isTTY);
	let received = 0;
	let reportedPct = -1;
	try {
		for await (const chunk of response.body) {
			sink.write(chunk);
			hasher.update(chunk);
			received += chunk.byteLength;
			if (!showProgress || total <= 0) continue;
			const pct = Math.min(100, Math.floor((received / total) * 100));
			if (pct === reportedPct) continue;
			reportedPct = pct;
			process.stderr.write(`\r  ${pct}% of ${formatBytes(total)}`);
		}
	} finally {
		await sink.end();
		if (showProgress && reportedPct >= 0) process.stderr.write("\r\x1b[2K");
	}

	if (total > 0 && received !== total) throw new Error(`download truncated: received ${received} of ${total} bytes`);
	return hasher.digest("hex");
}

async function extractArchive(archivePath: string, targetDir: string): Promise<void> {
	// bsdtar (macOS, Windows 10+) reads zip as well as tar; GNU tar only ever sees tar.gz here.
	const flag = archivePath.endsWith(".zip") ? "-xf" : "-xzf";
	const proc = Bun.spawn(["tar", flag, archivePath, "-C", targetDir], { stdout: "pipe", stderr: "pipe" });
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`could not extract ${basename(archivePath)}: ${stderr.trim() || `tar exited with ${exitCode}`}`);
	}
}

/**
 * Ad-hoc sign the staged macOS binaries, as `install.sh` does. Best-effort: the
 * version probe that follows is what decides whether the binary actually runs.
 */
async function adHocSign(paths: string[]): Promise<void> {
	if (process.platform !== "darwin") return;
	const proc = Bun.spawn(["codesign", "-s", "-", "-f", ...paths], { stdout: "pipe", stderr: "pipe" });
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	if (exitCode !== 0) process.stderr.write(`warning: codesign failed: ${stderr.trim()}\n`);
}

async function probeVersion(binaryPath: string): Promise<string> {
	const proc = Bun.spawn([binaryPath, "--version"], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`the downloaded binary would not run (exit ${exitCode}): ${(stderr || stdout).trim()}`);
	}
	return stdout.trim().replace(/^v/i, "");
}

/**
 * Replace `target` with `incoming` (both in `target`'s directory). POSIX renames
 * over a running executable; Windows cannot, so the old file is retired first and
 * deleted once the process holding it exits.
 */
async function swapBinary(incoming: string, target: string): Promise<void> {
	if (process.platform !== "win32") {
		await rename(incoming, target);
		return;
	}
	const retired = `${target}.retired-${process.pid}`;
	await rename(target, retired).catch(() => undefined);
	await rename(incoming, target);
	await unlink(retired).catch(() => undefined);
}

export interface InstallUpdateOptions extends ReleaseSource {
	/** Target `<os>-<arch>`; defaults to this machine. */
	platform?: string;
	/** Already-fetched release, so a caller that just checked does not re-fetch. */
	release?: ReleaseInfo;
	/** Directory holding the installed binaries; defaults to the running binary's directory. */
	installDir?: string;
	log?: (line: string) => void;
}

export interface InstallUpdateResult {
	fromVersion: string;
	toVersion: string;
	installDir: string;
	binaries: string[];
}

export async function installLatestRelease(options: InstallUpdateOptions = {}): Promise<InstallUpdateResult> {
	const log = options.log ?? (() => undefined);
	const platform = options.platform ?? platformKey();
	const exeSuffix = platform.startsWith("windows-") ? ".exe" : "";
	const installDir = options.installDir ?? (await installDirOf(process.execPath));
	const release = options.release ?? (await fetchLatestRelease(options));
	const asset = selectAsset(release, platform);
	const workDir = await mkdtemp(join(tmpdir(), "agy-multi-update-"));

	try {
		const archivePath = join(workDir, asset.name);
		log(`downloading ${asset.name} (${formatBytes(asset.size)})`);
		const actual = await downloadArchive(archivePath, asset, options);
		const expected = await expectedChecksum(release, asset, options);
		if (actual !== expected) {
			throw new Error(`checksum mismatch for ${asset.name}: expected ${expected}, downloaded ${actual}; nothing was installed`);
		}
		log(`sha256 ${expected}`);

		// The archive is laid out flat by the release workflow, so members land beside each other.
		const extractDir = join(workDir, "out");
		await mkdir(extractDir, { recursive: true });
		await extractArchive(archivePath, extractDir);

		const staged: string[] = [];
		for (const name of BINARIES) {
			const path = join(extractDir, `${name}${exeSuffix}`);
			const info = await stat(path).catch(() => null);
			if (!info?.isFile()) throw new Error(`${asset.name} did not contain ${name}${exeSuffix}`);
			await chmod(path, 0o755);
			staged.push(path);
		}

		if (platform.startsWith("darwin-")) await adHocSign(staged);
		const reported = await probeVersion(staged[0]!);
		if (compareVersions(reported, release.version) !== 0) {
			throw new Error(
				`the downloaded binary reports ${reported || "(no version)"}, expected ${release.version}; nothing was installed`,
			);
		}
		log(`verified agy-multi ${reported}`);

		// Copy into the install directory first: the swap below must be a same-device rename.
		await mkdir(installDir, { recursive: true }).catch(() => undefined);
		const installed: string[] = [];
		try {
			for (const [index, name] of BINARIES.entries()) {
				const target = join(installDir, `${name}${exeSuffix}`);
				const incoming = join(installDir, `.${name}${exeSuffix}.incoming-${process.pid}`);
				await copyFile(staged[index]!, incoming);
				await chmod(incoming, 0o755);
				await swapBinary(incoming, target);
				installed.push(target);
			}
		} catch (error) {
			throw new Error(
				`could not replace the binaries in ${installDir}: ${error instanceof Error ? error.message : String(error)}\n` +
					"Re-run with the permissions that installed them (e.g. `sudo agy-multi update`), or reinstall with install.sh",
			);
		}
		return { fromVersion: VERSION, toVersion: release.version, installDir, binaries: installed };
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

export interface UpdateCommandOptions {
	/** Report the latest release without installing anything. */
	check?: boolean;
	/** Reinstall even when the installed version is already current. */
	force?: boolean;
	platform?: string;
	log?: (line: string) => void;
}

export async function runUpdateCommand(options: UpdateCommandOptions = {}): Promise<void> {
	const platform = options.platform ?? platformKey();

	if (!options.check && !isCompiledBinary()) {
		throw new Error(
			`this agy-multi (${VERSION}) runs from source, so there is no installed binary to replace.\n` +
				"Rebuild the checkout, or reinstall:\n\n  git pull --ff-only && ./install.sh\n\n" +
				"Installed with `bun install -g`? Re-run that: bun install -g github:iqbal-codes/agy-multi",
		);
	}

	const release = await fetchLatestRelease();
	const comparison = compareVersions(release.version, VERSION);

	if (options.check) {
		const asset = selectAsset(release, platform);
		console.log(`current  ${VERSION}`);
		console.log(`latest   ${release.version}`);
		console.log(`binary   ${asset.name} (${formatBytes(asset.size)})`);
		if (comparison > 0) console.log("update available: run `agy-multi update`");
		else if (comparison === 0) console.log("up to date");
		else console.log(`current build is newer than the latest release (${release.tag})`);
		return;
	}

	if (!options.force && comparison <= 0) {
		console.log(
			comparison === 0
				? `agy-multi ${VERSION} is up to date (latest release ${release.tag}); pass --force to reinstall`
				: `agy-multi ${VERSION} is newer than the latest release ${release.tag}; nothing to do (pass --force to reinstall)`,
		);
		return;
	}

	const log = options.log ?? ((line: string) => process.stderr.write(`==> ${line}\n`));
	const result = await installLatestRelease({ platform, release, log });
	const verb = compareVersions(result.fromVersion, result.toVersion) === 0 ? "reinstalled" : "updated";
	console.log(`${verb} agy-multi ${result.fromVersion} → ${result.toVersion} in ${result.installDir}`);
	console.log("running sessions keep the previous binary until they restart");
}
