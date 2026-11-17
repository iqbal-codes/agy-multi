import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const FAKE_RUN_AGY = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";

const argv = Bun.argv.slice(2);
const home = process.env.HOME ?? "";
const isPro = home.includes("acct-pro");
const runLog = process.env.FAKE_RUN_LOG;

if (argv.includes("/usage")) {
  const pct = isPro ? "70%" : "95%";
  process.stdout.write(JSON.stringify({
    status: "SUCCESS",
    response: [
      "Gemini Models\\tWeekly Limit Remaining\\t" + pct + "\\t2099-01-01T00:00:00Z",
      "Gemini Models\\tFive Hour Limit Remaining\\t" + pct + "\\t2099-01-01T00:00:00Z",
    ].join("\\n"),
  }) + "\\n");
  process.exit(0);
}

if (argv[0] === "models") {
  const list = isPro
    ? ["gemini-4-hydrogen-high          Gemini 4 Hydrogen (High)", "gemini-3.8-flash-high           Gemini 3.8 Flash (High)"]
    : ["gemini-3.8-flash-high           Gemini 3.8 Flash (High)"];
  process.stdout.write(list.join("\\n") + "\\n");
  process.exit(0);
}

const modelIdx = argv.indexOf("--model");
const model = modelIdx >= 0 ? argv[modelIdx + 1] : undefined;
if (runLog) appendFileSync(runLog, (isPro ? "acct-pro" : "acct-basic") + ":" + (model ?? "") + "\\n");

const failSlug = process.env.FAKE_RUN_FAIL;
if (failSlug && home.includes(failSlug)) {
  process.stderr.write((process.env.FAKE_RUN_FAIL_MESSAGE ?? "RESOURCE_EXHAUSTED: quota exceeded") + "\\n");
  process.exit(1);
}

if (!isPro && model && model.startsWith("gemini-4-")) {
  process.stderr.write("Unknown model ID: " + model + "\\n");
  process.exit(1);
}

process.stdout.write(JSON.stringify({
  event: "result",
  result: { status: "SUCCESS", response: "OK from " + (isPro ? "acct-pro" : "acct-basic") },
}) + "\\n");
`;

async function setupCliEnv() {
	const root = await mkdtemp(join(tmpdir(), "agy-multi-run-models-"));
	const fake = join(root, "fake-agy");
	const runLog = join(root, "run.log");
	for (const slug of ["acct-basic", "acct-pro"]) {
		const dir = join(root, "profiles", slug);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "profile.json"), JSON.stringify({ slug, createdAt: new Date().toISOString() }));
		await writeFile(
			join(dir, "usage.json"),
			JSON.stringify({
				profile: slug,
				fetchedAt: Date.now(),
				windows: [
					{
						family: "gemini",
						window: "weekly",
						remainingPct: slug === "acct-pro" ? 70 : 95,
						resetsAt: "2099-01-01T00:00:00Z",
					},
				],
				raw: "",
			}),
		);
	}
	await writeFile(fake, FAKE_RUN_AGY);
	await chmod(fake, 0o755);
	return { root, fake, runLog };
}

describe("CLI run model capability selection", () => {
	test("auto-picks capable account via cached models without hitting basic account", async () => {
		const { root, fake, runLog } = await setupCliEnv();
		const projectRoot = join(import.meta.dir, "..");
		try {
			await writeFile(
				join(root, "profiles", "acct-basic", "models.json"),
				JSON.stringify({
					profile: "acct-basic",
					fetchedAt: Date.now(),
					models: [{ modelId: "gemini-3.8-flash-high" }],
				}),
			);
			await writeFile(
				join(root, "profiles", "acct-pro", "models.json"),
				JSON.stringify({
					profile: "acct-pro",
					fetchedAt: Date.now(),
					models: [{ modelId: "gemini-4-hydrogen-high" }, { modelId: "gemini-3.8-flash-high" }],
				}),
			);

			const proc = Bun.spawn(
				["bun", "run", join(projectRoot, "src/index.ts"), "run", "--allow-account-pool", "--switch-delay", "0", "--prompt", "hi", "--model", "gemini-4-hydrogen-high"],
				{
					cwd: projectRoot,
					env: { ...process.env, AGY_MULTI_ROOT: root, AGY_BIN: fake, FAKE_RUN_LOG: runLog },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const stdout = await new Response(proc.stdout).text();
			const code = await proc.exited;
			expect(code).toBe(0);
			expect(stdout.trim()).toBe("OK from acct-pro");
			const entries = (await readFile(runLog, "utf8")).trim().split("\n");
			expect(entries).toEqual(["acct-pro:gemini-4-hydrogen-high"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("fails with clear message when no account supports requested model", async () => {
		const { root, fake, runLog } = await setupCliEnv();
		const projectRoot = join(import.meta.dir, "..");
		try {
			for (const slug of ["acct-basic", "acct-pro"]) {
				await writeFile(
					join(root, "profiles", slug, "models.json"),
					JSON.stringify({
						profile: slug,
						fetchedAt: Date.now(),
						models: [{ modelId: "gemini-3.8-flash-high" }],
					}),
				);
			}

			const proc = Bun.spawn(
				["bun", "run", join(projectRoot, "src/index.ts"), "run", "--allow-account-pool", "--switch-delay", "0", "--prompt", "hi", "--model", "gemini-4-argon-high"],
				{
					cwd: projectRoot,
					env: { ...process.env, AGY_MULTI_ROOT: root, AGY_BIN: fake, FAKE_RUN_LOG: runLog },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const stderr = await new Response(proc.stderr).text();
			const code = await proc.exited;
			expect(code).not.toBe(0);
			expect(stderr).toContain("no available account supports model gemini-4-argon-high");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	for (const failure of [
		{ kind: "banned", message: "violation of Terms of Service" },
		{ kind: "quota", message: "RESOURCE_EXHAUSTED: quota exceeded" },
		{ kind: "auth", message: "not logged into Antigravity" },
	] as const) {
		test(`--profile reports a ${failure.kind} failure instead of retrying on another account`, async () => {
			const { root, fake, runLog } = await setupCliEnv();
			const projectRoot = join(import.meta.dir, "..");
			try {
				const proc = Bun.spawn(
					["bun", "run", join(projectRoot, "src/index.ts"), "run", "--prompt", "hi", "--profile", "acct-basic"],
					{
						cwd: projectRoot,
						env: {
							...process.env,
							AGY_MULTI_ROOT: root,
							AGY_BIN: fake,
							FAKE_RUN_LOG: runLog,
							FAKE_RUN_FAIL: "acct-basic",
							FAKE_RUN_FAIL_MESSAGE: failure.message,
						},
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const [stdout, stderr, code] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				expect(code, stderr).not.toBe(0);
				expect(`${stderr}${stdout}`).toContain(failure.kind);
				// Exactly one attempt, on the pinned account.
				expect((await readFile(runLog, "utf8")).trim().split("\n")).toEqual(["acct-basic:"]);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	}
});
