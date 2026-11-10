import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { LineReader } from "../src/acp/rpc";

// Disk survives agent restarts; the in-process session map deliberately does not.
const AGENT = String.raw`#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
const root = process.env.AGY_MULTI_ROOT;
const home = process.env.HOME;
const disk = root + "/disk-" + home.split("/").at(-2) + ".json";
const saved = () => existsSync(disk) ? JSON.parse(readFileSync(disk, "utf8")) : {};
const sessions = new Map();
const heldPrompts = new Map();
const send = m => process.stdout.write(JSON.stringify(m) + "\n");
if (Bun.argv.includes("/usage")) {
  send({ status: "SUCCESS", response: "Gemini Models\tWeekly Limit Remaining\t100%\t2099-01-01T00:00:00Z\nGemini Models\tFive Hour Limit Remaining\t100%\t2099-01-01T00:00:00Z" });
  process.exit(0);
}
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line), p = m.params || {};
  const ok = result => send({ jsonrpc: "2.0", id: m.id, result });
  const error = message => send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message } });
  const update = update => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: p.sessionId, update } });
  appendFileSync(root + "/requests.jsonl", JSON.stringify({ pid: process.pid, home, method: m.method, params: p }) + "\n");
  const control = JSON.parse(readFileSync(root + "/control.json", "utf8"));
  if (m.method === "initialize") return ok({ protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
  if (m.method === "session/new") {
    const id = randomUUID(); sessions.set(id, []);
    const d = saved(); d[id] = []; writeFileSync(disk, JSON.stringify(d));
    return ok({ sessionId: id, models: { currentModelId: "gemini-3.8-flash-high", availableModels: [] } });
  }
  if (m.method === "session/load" || m.method === "session/resume") {
    const d = saved();
    if (control.lost || !(p.sessionId in d)) return error("unknown session");
    sessions.set(p.sessionId, d[p.sessionId]);
    if (m.method === "session/load") for (const h of d[p.sessionId]) {
      update({ sessionUpdate: h.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: h.text } });
    }
    return ok({});
  }
  if (m.method === "session/test_usage") {
    update({ sessionUpdate: "usage_update", used: p.used, size: 262144 });
    if (p.finish) {
      send({ jsonrpc: "2.0", id: heldPrompts.get(p.sessionId), result: { stopReason: "end_turn" } });
      heldPrompts.delete(p.sessionId);
    }
    return ok({});
  }
  if (m.method === "session/prompt") {
    if (control.hold) {
      heldPrompts.set(p.sessionId, m.id);
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "TURN_STILL_RUNNING" } });
      return;
    }
    const text = p.prompt[0].text;
    if (text === "EXIT_CHILD") process.exit(0);
    if (!sessions.has(p.sessionId)) return error("unknown session");
    if (control.quota && home.includes("/acct-a/")) return error("RESOURCE_EXHAUSTED: quota exceeded");
    if (control.partial && home.includes("/acct-a/")) {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PARTIAL_REPLY" } });
      return error("RESOURCE_EXHAUSTED: quota exceeded");
    }
    if (control.usage) update({ sessionUpdate: "usage_update", used: control.used ?? 12345, size: 262144, cost: { amount: 0.25, currency: "USD" } });
    const history = sessions.get(p.sessionId);
    const answer = "ANSWER_" + text;
    history.push({ role: "user", text }, { role: "assistant", text: answer });
    const d = saved(); d[p.sessionId] = history; writeFileSync(disk, JSON.stringify(d));
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } });
    return ok({ stopReason: "end_turn" });
  }
  if (m.method === "session/set_model" && control.rejectModel) return error("selected model unavailable");
  if (m.method === "session/close" || m.method === "session/set_model") return ok({});
  return error("unsupported: " + m.method);
});
`;

type Reply = { result?: { sessionId?: string; stopReason?: string }; error?: { message: string } };
type Notification = { params?: { sessionId: string; update: { sessionUpdate: string; used?: number; size?: number; cost?: unknown } } };
type Request = { pid: number; home: string; method: string; params: { sessionId?: string; prompt?: { text: string }[] } };

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "agy-persistence-"));
	const project = join(import.meta.dir, "..");
	const fake = join(root, "fake-agy");
	await writeFile(fake, AGENT);
	await chmod(fake, 0o755);
	for (const slug of ["acct-a", "acct-b"]) {
		const dir = join(root, "profiles", slug);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "profile.json"), JSON.stringify({ slug, createdAt: new Date().toISOString() }));
	}
	const control = (value: Record<string, unknown>) => writeFile(join(root, "control.json"), JSON.stringify(value));
	await control({});
	const clients: { close(): Promise<void> }[] = [];
	const start = async () => {
		const proc = Bun.spawn(["bun", "run", join(project, "src/index.ts"), "acp"], {
			cwd: project,
			env: { ...process.env, AGY_MULTI_ROOT: root, AGY_BIN: fake },
			stdin: "pipe", stdout: "pipe", stderr: "pipe",
		});
		const pending = new Map<number, (value: Reply) => void>();
		const notifications: Notification[] = [];
		const listeners = new Set<(notification: Notification) => void>();
		const waitForUpdate = (kind: string) => new Promise<Notification>((resolve, reject) => {
			const listener = (notification: Notification) => {
				if (notification.params?.update.sessionUpdate !== kind) return;
				clearTimeout(timeout); listeners.delete(listener); resolve(notification);
			};
			const timeout = setTimeout(() => { listeners.delete(listener); reject(new Error(`timed out waiting for ${kind}`)); }, 3000);
			listeners.add(listener);
		});
		let next = 0;
		new LineReader(proc.stdout, line => {
			const message = JSON.parse(line);
			if (pending.has(message.id)) {
				pending.get(message.id)!(message);
				pending.delete(message.id);
			} else {
				notifications.push(message);
				for (const listener of listeners) listener(message);
			}
		});
		const request = (method: string, params: unknown) => new Promise<Reply>((resolve, reject) => {
			const id = ++next;
			const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`timed out: ${method}`)); }, 5000);
			pending.set(id, message => { clearTimeout(timeout); resolve(message); });
			proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			void proc.stdin.flush();
		});
		let closed = false;
		const close = async () => { if (!closed) { closed = true; proc.kill(); await proc.exited; } };
		const client = {
			request, notifications, waitForUpdate, close,
			prompt: (sessionId: string, text: string) => request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }),
			newSession: async () => {
				const response = await request("session/new", { cwd: root, mcpServers: [], additionalDirectories: [root] });
				expect(response.error).toBeUndefined();
				return response.result!.sessionId!;
			},
		};
		clients.push(client);
		await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
		return client;
	};
	return {
		root, control, start,
		requests: async (): Promise<Request[]> => (await readFile(join(root, "requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)),
		store: async () => JSON.parse(await readFile(join(root, "acp-sessions.json"), "utf8")).sessions,
		cleanup: async () => { await Promise.all(clients.map(c => c.close())); await rm(root, { recursive: true, force: true }); },
	};
}

test("consecutive prompts and proxy restart keep the same backend conversation", async () => {
	const f = await fixture();
	try {
		let c = await f.start(); const id = await c.newSession();
		await c.prompt(id, "FIRST"); await c.prompt(id, "SECOND");
		await c.close(); c = await f.start();
		await c.request("session/resume", { sessionId: id, cwd: f.root });
		expect((await c.prompt(id, "THIRD")).error).toBeUndefined();
		const prompts = (await f.requests()).filter(r => r.method === "session/prompt");
		expect(new Set(prompts.map(r => r.params.sessionId)).size).toBe(1);
	} finally { await f.cleanup(); }
});

test("native usage is not replaced by synthetic context numbers, including compaction", async () => {
	const f = await fixture();
	try {
		await f.control({ usage: true, used: 250000 });
		const c = await f.start(); const id = await c.newSession();
		await c.prompt(id, "FIRST");
		await f.control({ usage: true, used: 35000 }); await c.prompt(id, "SECOND");
		const updates = c.notifications.filter(n => n.params?.update.sessionUpdate === "usage_update");
		expect(updates.map(n => n.params!.update.used)).toEqual([250000, 35000]);
		expect(updates.at(-1)?.params).toEqual({ sessionId: id, update: { sessionUpdate: "usage_update", used: 35000, size: 262144, cost: { amount: 0.25, currency: "USD" } } });
	} finally { await f.cleanup(); }
});

test("usage updates reach the client repeatedly while the prompt is still running", async () => {
	const f = await fixture();
	try {
		await f.control({ hold: true });
		const c = await f.start(); const id = await c.newSession();
		let finished = false;
		const started = c.waitForUpdate("agent_message_chunk");
		const prompt = c.prompt(id, "LONG_RUNNING").then(reply => { finished = true; return reply; });
		await started;
		for (const used of [10000, 25000, 3500]) {
			const usage = c.waitForUpdate("usage_update");
			expect((await c.request("session/test_usage", { sessionId: id, used })).error).toBeUndefined();
			expect((await usage).params).toEqual({ sessionId: id, update: { sessionUpdate: "usage_update", used, size: 262144 } });
			expect(finished).toBe(false);
		}
		await c.request("session/test_usage", { sessionId: id, used: 5000, finish: true });
		expect((await prompt).error).toBeUndefined();
		expect(finished).toBe(true);
	} finally { await f.cleanup(); }
});

test("unknown model capacity does not produce a fabricated context meter", async () => {
	const f = await fixture();
	try {
		const c = await f.start(); const id = await c.newSession(); await c.prompt(id, "FIRST");
		expect(c.notifications.filter(n => n.params?.update.sessionUpdate === "usage_update")).toEqual([]);
	} finally { await f.cleanup(); }
});

for (const method of ["session/resume", "session/load"]) {
	test(`${method} after restart retains prior turns for account handoff without duplicate replay`, async () => {
		const f = await fixture();
		try {
			let c = await f.start(); const id = await c.newSession();
			await c.request("session/set_model", { sessionId: id, modelId: "gemini-selected" });
			await c.prompt(id, "FIRST"); await c.prompt(id, "SECOND");
			await c.close(); c = await f.start();
			await c.request(method, { sessionId: id, cwd: f.root });
			await f.control({ quota: true });
			expect((await c.prompt(id, "THIRD")).error).toBeUndefined();
			const prompt = (await f.requests()).filter(r => r.method === "session/prompt").at(-1)!;
			const text = prompt.params.prompt![0]!.text;
			for (const marker of ["User:\nFIRST", "Assistant:\nANSWER_FIRST", "User:\nSECOND", "User:\nTHIRD"]) {
				expect(text.split(marker).length - 1).toBe(1);
			}
			expect((await f.store())[id].profile).toBe("acct-b");
			expect((await f.requests()).some(r => r.home.includes("acct-b") && r.method === "session/set_model")).toBe(true);
		} finally { await f.cleanup(); }
	});
}

test("a new child process resumes the backend session before the next prompt", async () => {
	const f = await fixture();
	try {
		const c = await f.start(); const id = await c.newSession(); await c.prompt(id, "FIRST");
		expect((await c.prompt(id, "EXIT_CHILD")).error).toBeDefined();
		expect((await c.prompt(id, "AFTER_EXIT")).error).toBeUndefined();
		const requests = await f.requests(); const last = requests.filter(r => r.method === "session/prompt").at(-1)!;
		expect(requests.some(r => r.pid === last.pid && r.method === "session/resume" && r.params.sessionId === last.params.sessionId)).toBe(true);
		expect(requests.filter(r => r.method === "session/new")).toHaveLength(1);
	} finally { await f.cleanup(); }
});

test("lost child session creates one replacement with prior history and selected model", async () => {
	const f = await fixture();
	try {
		const c = await f.start(); const id = await c.newSession();
		await c.request("session/set_model", { sessionId: id, modelId: "gemini-selected" });
		await c.prompt(id, "FIRST"); await c.prompt(id, "EXIT_CHILD"); await f.control({ lost: true });
		expect((await c.prompt(id, "RECOVER")).error).toBeUndefined();
		const requests = await f.requests();
		expect(requests.filter(r => r.method === "session/new")).toHaveLength(2);
		const last = requests.filter(r => r.method === "session/prompt").at(-1)!;
		expect(last.params.prompt![0]!.text).toContain("User:\nFIRST");
		expect(last.params.prompt![0]!.text).toContain("User:\nRECOVER");
		expect(requests.some(r => r.pid === last.pid && r.method === "session/set_model")).toBe(true);
	} finally { await f.cleanup(); }
});

test("legacy mapping without persisted history hydrates from load before a resume handoff", async () => {
	const f = await fixture();
	try {
		let c = await f.start(); const id = await c.newSession(); await c.prompt(id, "LEGACY_FIRST");
		await c.close();
		const records = await f.store(); delete records[id].history;
		await writeFile(join(f.root, "acp-sessions.json"), JSON.stringify({ version: 1, sessions: records }));
		c = await f.start();
		expect((await c.request("session/resume", { sessionId: id, cwd: f.root })).error).toBeUndefined();
		expect(c.notifications.some(n => n.params?.update.sessionUpdate === "user_message_chunk")).toBe(false);
		await f.control({ quota: true });
		expect((await c.prompt(id, "CONTINUE")).error).toBeUndefined();
		const last = (await f.requests()).filter(r => r.method === "session/prompt").at(-1)!;
		expect(last.params.prompt![0]!.text).toContain("User:\nLEGACY_FIRST");
	} finally { await f.cleanup(); }
});

test("unavailable selected model stops a handoff rather than silently using another model", async () => {
	const f = await fixture();
	try {
		const c = await f.start(); const id = await c.newSession(); await c.prompt(id, "FIRST");
		await f.control({ quota: true, rejectModel: true });
		expect((await c.prompt(id, "CONTINUE")).error?.message).toBe("selected model unavailable");
		expect((await f.requests()).some(r => r.method === "session/prompt" && r.home.includes("acct-b"))).toBe(false);
		await f.control({}); expect((await c.prompt(id, "RETRY")).error).toBeUndefined();
		const last = (await f.requests()).filter(r => r.method === "session/prompt").at(-1)!;
		expect(last.params.prompt![0]!.text).toContain("User:\nFIRST");
	} finally { await f.cleanup(); }
});

test("storage failure fails the turn before generation and later writes can recover", async () => {
	const f = await fixture();
	try {
		const c = await f.start(); const id = await c.newSession();
		const path = join(f.root, "acp-sessions.json");
		await rename(path, `${path}.backup`); await mkdir(path);
		expect((await c.prompt(id, "MUST_NOT_RUN")).error).toBeDefined();
		expect((await f.requests()).filter(r => r.method === "session/prompt")).toHaveLength(0);
		await rm(path, { recursive: true }); await rename(`${path}.backup`, path);
		expect((await c.prompt(id, "RECOVER")).error).toBeUndefined();
	} finally { await f.cleanup(); }
});

test("partial failed turn is persisted before restart and carried into handoff", async () => {
	const f = await fixture();
	try {
		let c = await f.start(); const id = await c.newSession(); await f.control({ partial: true });
		expect((await c.prompt(id, "FIRST")).error).toBeDefined();
		await c.close(); c = await f.start(); await c.request("session/resume", { sessionId: id, cwd: f.root });
		await f.control({}); expect((await c.prompt(id, "CONTINUE")).error).toBeUndefined();
		const last = (await f.requests()).filter(r => r.method === "session/prompt").at(-1)!;
		expect(last.params.prompt![0]!.text).toContain("PARTIAL_REPLY");
		expect(last.params.prompt![0]!.text).toContain("User:\nFIRST");
	} finally { await f.cleanup(); }
});
