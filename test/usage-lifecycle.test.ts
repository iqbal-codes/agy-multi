import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineReader } from "../src/acp/rpc";

// Reproduce the CLI's dangerous fallback: an interrupted credential helper
// causes its parent to attempt interactive OAuth. No real browser is used.
const CLI = String.raw`#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
if (process.argv.includes("acp")) {
  for await (const chunk of Bun.stdin.stream()) {
    for (const line of new TextDecoder().decode(chunk).trim().split("\n")) {
      const message = JSON.parse(line);
      const result = message.method === "initialize" ? {protocolVersion:1,agentCapabilities:{},authMethods:[]} : {sessionId:"probe-session"};
      console.log(JSON.stringify({jsonrpc:"2.0",id:message.id,result}));
    }
  }
  process.exit(0);
}
const child = Bun.spawn([process.execPath, "-e", 'process.on("SIGTERM",()=>{console.log("interrupted");process.exit(1)});console.log("ready");setInterval(()=>{},1000)'], {stdout:"pipe",stderr:"ignore"});
const reader = child.stdout.getReader();
await reader.read();
function oauth() {
  writeFileSync(process.env.BROWSER_MARKER, "OAuth attempted");
  process.exit(1);
}
process.on("SIGTERM", oauth);
process.on("exit", () => child.kill("SIGKILL"));
void reader.read().then(({value}) => { if (value) oauth(); });
writeFileSync(process.env.STARTED_MARKER, JSON.stringify({pid:process.pid,helper:child.pid}));
if (process.env.SCENARIO === "normal" || process.env.SCENARIO === "host-signal") {
  setTimeout(() => {
    console.log(JSON.stringify({status:"SUCCESS",response:"Gemini Models\tFive Hour Limit Remaining\t40%\t2027-01-01T00:00:00Z"}));
    process.exit(0);
  }, 200);
} else setInterval(()=>{},1000);
`;

const WORKER = String.raw`
import { fetchUsage, readCachedUsage } from "USAGE_MODULE";
const controller = new AbortController();
const scenario = process.env.SCENARIO;
process.on("SIGTERM", () => {});
if (scenario === "pre-abort") controller.abort();
const result = fetchUsage({slug:"probe",home:process.env.TEST_HOME,createdAt:"now"}, 1500, controller.signal);
if (scenario === "abort" || scenario === "host-signal") {
  const deadline = Date.now()+4000;
  while (!(await Bun.file(process.env.STARTED_MARKER).exists())) {
    if(Date.now()>deadline) throw Error("CLI did not start");
    await Bun.sleep(5);
  }
  if(scenario === "abort") controller.abort();
  else process.kill(-process.pid,"SIGTERM");
}
const snapshot = await result;
console.log(JSON.stringify({snapshot,cached:await readCachedUsage("probe"),browser:await Bun.file(process.env.BROWSER_MARKER).exists(),started:await Bun.file(process.env.STARTED_MARKER).exists()}));
`;

async function probe(scenario: string) {
	const root = await mkdtemp(join(tmpdir(), "agy-usage-lifecycle-"));
	const cli = join(root, "agy");
	const worker = join(root, "worker.ts");
	await writeFile(cli, CLI);
	await chmod(cli, 0o755);
	await writeFile(worker, WORKER.replace("USAGE_MODULE", join(import.meta.dir, "../src/usage.ts")));
	const proc = Bun.spawn([process.execPath, worker], {
		detached: true,
		env: { ...process.env, AGY_BIN: cli, AGY_MULTI_ROOT: root, TEST_HOME: root, SCENARIO: scenario,
			STARTED_MARKER: join(root, "started"), BROWSER_MARKER: join(root, "browser") },
		stdout: "pipe", stderr: "pipe",
	});
	try {
		const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		expect(await proc.exited, err).toBe(0);
		return JSON.parse(out);
	} finally {
		try { process.kill(-proc.pid, "SIGKILL"); } catch {}
		// Clean up fake descendants even when exercising the old broken implementation.
		try {
			const { pid, helper } = await Bun.file(join(root, "started")).json();
			for (const id of [pid, helper]) { try { process.kill(id, "SIGKILL"); } catch {} }
		} catch {}
		await rm(root, { recursive: true, force: true });
	}
}

describe.skipIf(process.platform === "win32")("quota subprocess lifecycle", () => {
	test("timeout cannot turn interrupted auth into a browser attempt", async () => {
		const result = await probe("timeout");
		expect(result.started).toBe(true);
		expect(result.browser).toBe(false);
		expect(result.snapshot).toBeNull();
		expect(result.cached).toBeNull();
	}, 8000);
	test("cancellation stops an in-flight credential read without OAuth", async () => {
		const result = await probe("abort");
		expect(result.started).toBe(true);
		expect(result.browser).toBe(false);
		expect(result.snapshot).toBeNull();
		expect(result.cached).toBeNull();
	}, 8000);
	test("a cancelled probe cannot launch a late quota process", async () => {
		const result = await probe("pre-abort");
		expect(result.started).toBe(false);
		expect(result.snapshot).toBeNull();
	}, 8000);
	test("host process-group termination cannot interrupt quota auth", async () => {
		const result = await probe("host-signal");
		expect(result.browser).toBe(false);
		expect(result.snapshot?.windows[0]?.remainingPct).toBe(40);
	}, 8000);
	test("successful checks still cache real quota results", async () => {
		const result = await probe("normal");
		expect(result.browser).toBe(false);
		expect(result.snapshot?.windows[0]?.remainingPct).toBe(40);
		expect(result.cached?.windows).toEqual(result.snapshot.windows);
	}, 8000);
	test("ACP stdin closure cancels pending quota children without OAuth", async () => {
		const root = await mkdtemp(join(tmpdir(), "agy-acp-quota-shutdown-"));
		const cli = join(root, "agy");
		const marker = join(root, "started");
		const browser = join(root, "browser");
		await writeFile(cli, CLI);
		await chmod(cli, 0o755);
		await Bun.write(join(root, "profiles/probe/profile.json"), JSON.stringify({ slug: "probe", home: root, createdAt: "now" }));
		const proxy = Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts"), "acp"], {
			detached: true,
			env: { ...process.env, AGY_BIN: cli, AGY_MULTI_ROOT: root, STARTED_MARKER: marker, BROWSER_MARKER: browser, SCENARIO: "abort" },
			stdin: "pipe", stdout: "pipe", stderr: "pipe",
		});
		const replies = new Map<number, (value: unknown) => void>();
		new LineReader(proxy.stdout, line => {
			const message = JSON.parse(line);
			if (typeof message.id === "number") replies.get(message.id)?.(message);
		});
		const request = (id: number, method: string, params: unknown) => new Promise(resolve => {
			replies.set(id, resolve);
			proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
			void proxy.stdin.flush();
		});
		try {
			await request(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
			await request(2, "session/new", { cwd: root, mcpServers: [] });
			const deadline = Date.now() + 3000;
			while (!(await Bun.file(marker).exists())) {
				if (Date.now() > deadline) throw new Error("quota reader did not start");
				await Bun.sleep(5);
			}
			const { pid, helper } = await Bun.file(marker).json();
			proxy.stdin.end();
			expect(await proxy.exited).toBe(0);
			// A leaked CLI would still be waiting on the credential reader here.
			const alive = (id: number) => { try { process.kill(id, 0); return true; } catch { return false; } };
			const stoppedBy = Date.now() + 2000;
			while ((alive(pid) || alive(helper)) && Date.now() < stoppedBy) await Bun.sleep(10);
			expect(alive(pid)).toBe(false);
			expect(alive(helper)).toBe(false);
			expect(await Bun.file(browser).exists()).toBe(false);
		} finally {
			try { process.kill(-proxy.pid, "SIGKILL"); } catch {}
			try {
				const { pid, helper } = await Bun.file(marker).json();
				for (const id of [pid, helper]) { try { process.kill(id, "SIGKILL"); } catch {} }
			} catch {}
			await rm(root, { recursive: true, force: true });
		}
	}, 8000);
});
