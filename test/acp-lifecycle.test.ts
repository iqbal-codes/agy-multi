import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineReader } from "../src/acp/rpc";

// Real descendants deliberately outlive their parent and ignore SIGTERM, like
// a stuck MCP server. All processes belong to this isolated temporary fixture.
const HELPER = String.raw`
const grandchild = Bun.spawn([process.execPath,"-e",'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'],{stdout:"ignore",stderr:"ignore"});
process.on("SIGTERM",()=>{});
console.log(JSON.stringify({helper:process.pid,grandchild:grandchild.pid}));
setInterval(()=>{},1000);
`;
const AGENT = String.raw`#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (Bun.argv.includes("/usage")) {
  console.log(JSON.stringify({status:"SUCCESS",response:""}));
  process.exit(0);
}
if (Bun.argv.includes("models")) {
  console.log("gemini-3.8-flash-high  Gemini Flash");
  process.exit(0);
}
const helper = Bun.spawn([process.execPath, "-e", ${JSON.stringify(HELPER)}], {stdout:"pipe",stderr:"ignore"});
const reader = helper.stdout.getReader();
const {value} = await reader.read();
const descendants = JSON.parse(new TextDecoder().decode(value));
writeFileSync(process.env.PIDS_FILE, JSON.stringify({agent:process.pid,...descendants}));
let sequence = 0;
const send = m => console.log(JSON.stringify(m));
createInterface({input:process.stdin}).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "session/test_exit") process.exit(0);
  const result = m.method === "initialize"
    ? {protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}
    : m.method === "session/new" ? {sessionId:"session-"+(++sequence)} : {};
  send({jsonrpc:"2.0",id:m.id,result});
});
`;

const alive = (pid: number) => {
	try { process.kill(pid, 0); return true; } catch { return false; }
};

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "agy-acp-lifecycle-"));
	const cli = join(root, "agy");
	const pidsFile = join(root, "pids.json");
	await writeFile(cli, AGENT);
	await chmod(cli, 0o755);
	await Bun.write(join(root, "profiles/probe/profile.json"), JSON.stringify({slug:"probe", home:root, createdAt:"now"}));
	// ACP serves one operator-selected account; record it so the entrypoint does
	// not fail closed before the process-lifecycle behaviour under test runs.
	await writeFile(join(root, "state.json"), JSON.stringify({version:2, defaultProfile:"probe", pins:{}, blocks:{}, checkpoints:{}}));
	const proxyCommand = process.env.AGY_TEST_ACP_BIN
		? [process.env.AGY_TEST_ACP_BIN]
		: [process.execPath, join(import.meta.dir, "../src/acp-bin.ts")];
	const proxy = Bun.spawn(proxyCommand, {
		detached: true,
		env: {...process.env, AGY_MULTI_ROOT:root, AGY_BIN:cli, PIDS_FILE:pidsFile},
		stdin:"pipe", stdout:"pipe", stderr:"pipe",
	});
	let seq = 0;
	const logs: string[] = [];
	new LineReader(proxy.stderr, line => logs.push(line));
	const pending = new Map<number, (reply: any) => void>();
	new LineReader(proxy.stdout, line => {
		const m = JSON.parse(line);
		pending.get(m.id)?.(m);
		pending.delete(m.id);
	});
	const request = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
		const id = ++seq;
		const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 3000);
		pending.set(id, reply => { clearTimeout(timer); resolve(reply); });
		proxy.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");
		void proxy.stdin.flush();
	});
	const pids = () => Bun.file(pidsFile).json() as Promise<{agent:number;helper:number;grandchild:number}>;
	return {
		root, proxy, request, pids, logs,
		async start() {
			const reply = await request("initialize", {protocolVersion:1,clientCapabilities:{}});
			expect(reply.error).toBeUndefined();
		},
		newSession: () => request("session/new", {cwd:root,mcpServers:[]}),
		async stopped() {
			const ids = Object.values(await pids());
			const until = Date.now()+1000;
			while (ids.some(alive) && Date.now()<until) await Bun.sleep(10);
			return ids.filter(alive).length;
		},
		async cleanup() {
			try { proxy.kill("SIGKILL"); } catch {}
			await proxy.exited;
			try { process.kill(-proxy.pid,"SIGKILL"); } catch {}
			try { for (const pid of Object.values(await pids())) { try { process.kill(pid,"SIGKILL"); } catch {} } } catch {}
			await rm(root,{recursive:true,force:true});
		},
	};
}

describe.skipIf(process.platform === "win32")("ACP owned process lifecycle", () => {
	for (const shutdown of ["stdin", "SIGTERM"] as const) {
		test(`${shutdown} shutdown leaves no agent or MCP descendants`, async () => {
			const f = await fixture();
			try {
				await f.start();
				const ids = Object.values(await f.pids());
				expect(ids.every(alive)).toBe(true);
				if (shutdown === "stdin") f.proxy.stdin.end(); else f.proxy.kill("SIGTERM");
				expect(await f.proxy.exited).toBe(0);
				expect(await f.stopped()).toBe(0);
			} finally { await f.cleanup(); }
		}, 8000);
	}

	test("an agent exiting unexpectedly does not orphan its MCP descendants", async () => {
		const f = await fixture();
		try {
			await f.start();
			expect((await f.request("session/test_exit")).error).toBeDefined();
			expect(await f.stopped(), f.logs.join("\n")).toBe(0);
		} finally { await f.cleanup(); }
	}, 8000);

	test("closing one shared session keeps its sibling alive; closing the last releases the process tree", async () => {
		const f = await fixture();
		try {
			await f.start();
			const first = (await f.newSession()).result.sessionId;
			const second = (await f.newSession()).result.sessionId;
			const original = await f.pids();
			expect((await f.request("session/close",{sessionId:first})).error).toBeUndefined();
			expect(Object.values(original).every(alive)).toBe(true);
			expect((await f.request("session/prompt",{sessionId:second,prompt:[{type:"text",text:"hello"}]})).error).toBeUndefined();
			expect((await f.request("session/close",{sessionId:second})).error).toBeUndefined();
			expect(await f.stopped(), f.logs.join("\n")).toBe(0);
			// The proxy remains available and creates a new agent on demand.
			expect((await f.newSession()).error).toBeUndefined();
			expect((await f.pids()).agent).not.toBe(original.agent);
		} finally { await f.cleanup(); }
	}, 10000);

	test("a concurrent new session survives closing the previous last session", async () => {
		const f = await fixture();
		try {
			await f.start();
			const previous = (await f.newSession()).result.sessionId;
			const [closed, created] = await Promise.all([
				f.request("session/close", {sessionId:previous}),
				f.newSession(),
			]);
			expect(closed.error).toBeUndefined();
			expect(created.error).toBeUndefined();
			expect((await f.request("session/prompt", {
				sessionId:created.result.sessionId, prompt:[{type:"text",text:"still usable"}],
			})).error).toBeUndefined();
			expect(Object.values(await f.pids()).every(alive)).toBe(true);
		} finally { await f.cleanup(); }
	}, 8000);
});
