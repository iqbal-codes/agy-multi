import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fetchLatestRelease,
	installLatestRelease,
	parseChecksums,
	platformKey,
	runUpdateCommand,
	selectAsset,
	type ReleaseInfo,
} from "../src/update";

const PLATFORM = "linux-x64";
const ASSET = `agy-multi-${PLATFORM}.tar.gz`;

function sha256(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** A release archive as the release workflow builds it: two executables, flat. */
function buildArchive(binaryVersion: string): Uint8Array {
	const work = mkdtempSync(join(tmpdir(), "agy-release-"));
	const stage = join(work, "stage");
	mkdirSync(stage, { recursive: true });
	for (const name of ["agy-multi", "agy-multi-acp"]) {
		const path = join(stage, name);
		// Stands in for the compiled binary: the installer only asks it for --version.
		writeFileSync(path, `#!/bin/sh\necho ${binaryVersion}\n`);
		chmodSync(path, 0o755);
	}
	const archive = join(work, ASSET);
	const proc = Bun.spawnSync(["tar", "-czf", archive, "-C", stage, "."]);
	if (proc.exitCode !== 0) throw new Error(`tar failed: ${proc.stderr.toString()}`);
	return readFileSync(archive);
}

interface FakeRelease {
	tag: string;
	assetName: string;
	archive: Uint8Array;
	/** `sha256:<hex>` as GitHub reports it; null models a release without a digest. */
	digest: string | null;
	/** SHA256SUMS.txt body, when the release carries one. */
	checksums: string | null;
}

function makeRelease(
	options: {
		tag?: string;
		binaryVersion?: string;
		digest?: string | null;
		checksums?: boolean;
	} = {},
): FakeRelease {
	const tag = options.tag ?? "v9.9.0";
	const archive = buildArchive(options.binaryVersion ?? tag.replace(/^v/, ""));
	const hex = sha256(archive);
	return {
		tag,
		assetName: ASSET,
		archive,
		digest: options.digest === undefined ? `sha256:${hex}` : options.digest,
		checksums: options.checksums ? `${hex}  ${ASSET}\n` : null,
	};
}

let release: FakeRelease | null = null;
let server: ReturnType<typeof Bun.serve>;
let apiBase = "";

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch(request) {
			const { pathname } = new URL(request.url);
			const current = release;
			if (pathname === "/repos/iqbal-codes/agy-multi/releases/latest") {
				if (!current) return new Response("no release staged", { status: 500 });
				const assets = [
					{
						name: current.assetName,
						browser_download_url: `${apiBase}/download/${current.assetName}`,
						size: current.archive.byteLength,
						digest: current.digest,
					},
					...(current.checksums
						? [{ name: "SHA256SUMS.txt", browser_download_url: `${apiBase}/SHA256SUMS.txt`, size: current.checksums.length }]
						: []),
				];
				return Response.json({ tag_name: current.tag, assets });
			}
			if (current && pathname === `/download/${current.assetName}`) {
				return new Response(current.archive, {
					headers: { "content-length": String(current.archive.byteLength) },
				});
			}
			if (current?.checksums && pathname === "/SHA256SUMS.txt") return new Response(current.checksums);
			return new Response("not found", { status: 404 });
		},
	});
	apiBase = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server.stop(true);
});

async function freshInstallDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "agy-install-"));
	await writeFile(join(dir, "agy-multi"), "#!/bin/sh\necho 1.0.0\n", { mode: 0o755 });
	await writeFile(join(dir, "agy-multi-acp"), "#!/bin/sh\necho 1.0.0\n", { mode: 0o755 });
	return dir;
}

describe("release metadata", () => {
	test("selectAsset prefers the platform archive and names what a release does publish", () => {
		const info: ReleaseInfo = {
			tag: "v2.0.0",
			version: "2.0.0",
			assets: [
				{ name: "agy-multi-darwin-arm64.tar.gz", url: "u", size: 1 },
				{ name: "SHA256SUMS.txt", url: "u", size: 1 },
			],
		};
		expect(selectAsset(info, "darwin-arm64").name).toBe("agy-multi-darwin-arm64.tar.gz");
		expect(() => selectAsset(info, "linux-x64")).toThrow(/no binary for linux-x64.*darwin-arm64/);
	});

	test("platformKey maps the three shipped operating systems", () => {
		expect(platformKey("darwin", "arm64")).toBe("darwin-arm64");
		expect(platformKey("linux", "x64")).toBe("linux-x64");
		expect(platformKey("win32", "x64")).toBe("windows-x64");
		expect(() => platformKey("freebsd", "x64")).toThrow(/no binary for freebsd/);
		expect(() => platformKey("darwin", "ia32")).toThrow(/no binary for darwin-ia32/);
	});

	test("parseChecksums reads sha256sum output, binary mode marker included", () => {
		const hex = "a".repeat(64);
		const sums = parseChecksums(`${hex}  ${ASSET}\n${hex.toUpperCase()} *agy-multi-darwin-x64.tar.gz\nnot a checksum line\n`);
		expect(sums.get(ASSET)).toBe(hex);
		expect(sums.get("agy-multi-darwin-x64.tar.gz")).toBe(hex);
		expect(sums.size).toBe(2);
	});

	test("a repository without a release fails with a clear message", async () => {
		await expect(fetchLatestRelease({ repoSlug: "unknown/repo", apiBase })).rejects.toThrow(/no published release/);
	});
});

describe("installLatestRelease", () => {
	test("replaces both binaries with the verified release build", async () => {
		release = makeRelease({ tag: "v9.9.0" });
		const installDir = await freshInstallDir();

		const result = await installLatestRelease({ platform: PLATFORM, installDir, apiBase });

		expect(result.toVersion).toBe("9.9.0");
		expect(result.installDir).toBe(installDir);
		expect(result.binaries).toEqual([join(installDir, "agy-multi"), join(installDir, "agy-multi-acp")]);
		for (const name of ["agy-multi", "agy-multi-acp"]) {
			const installed = join(installDir, name);
			expect(await readFile(installed, "utf8")).toContain("9.9.0");
			expect((await stat(installed)).mode & 0o777).toBe(0o755);
		}
		// Nothing staged is left behind in the install directory.
		expect(readdirSync(installDir).sort()).toEqual(["agy-multi", "agy-multi-acp"]);
	});

	test("falls back to the release's SHA256SUMS.txt when GitHub reports no digest", async () => {
		release = makeRelease({ tag: "v9.9.1", digest: null, checksums: true });
		const installDir = await freshInstallDir();

		const result = await installLatestRelease({ platform: PLATFORM, installDir, apiBase });

		expect(result.toVersion).toBe("9.9.1");
		expect(await readFile(join(installDir, "agy-multi"), "utf8")).toContain("9.9.1");
	});

	test("refuses a release with no checksum at all", async () => {
		release = makeRelease({ tag: "v9.9.2", digest: null });
		const installDir = await freshInstallDir();

		await expect(installLatestRelease({ platform: PLATFORM, installDir, apiBase })).rejects.toThrow(
			/publishes no checksum/,
		);
		expect(await readFile(join(installDir, "agy-multi"), "utf8")).toContain("1.0.0");
	});

	test("refuses an archive whose bytes do not match the published digest", async () => {
		release = makeRelease({ tag: "v9.9.3", digest: `sha256:${"b".repeat(64)}` });
		const installDir = await freshInstallDir();

		await expect(installLatestRelease({ platform: PLATFORM, installDir, apiBase })).rejects.toThrow(
			/checksum mismatch.*nothing was installed/,
		);
		expect(await readFile(join(installDir, "agy-multi"), "utf8")).toContain("1.0.0");
	});

	test("refuses a binary that reports a version other than the release's", async () => {
		release = makeRelease({ tag: "v9.9.4", binaryVersion: "8.0.0" });
		const installDir = await freshInstallDir();

		await expect(installLatestRelease({ platform: PLATFORM, installDir, apiBase })).rejects.toThrow(
			/reports 8\.0\.0, expected 9\.9\.4/,
		);
		expect(await readFile(join(installDir, "agy-multi"), "utf8")).toContain("1.0.0");
		expect(await readFile(join(installDir, "agy-multi-acp"), "utf8")).toContain("1.0.0");
	});
});

describe("runUpdateCommand", () => {
	test("refuses to install when running from source", async () => {
		await expect(runUpdateCommand({})).rejects.toThrow(/runs from source/);
	});
});
