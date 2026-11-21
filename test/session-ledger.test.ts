import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	buildHandoffPrompt,
	loadAcpSessions,
	promptToText,
	renderHistory,
	SessionLedger,
} from "../src/acp/session-ledger";

describe("ACP prompt & handoff helpers", () => {
	test("extracts text, file links, and images", () => {
		expect(
			promptToText([
				{ type: "text", text: "hello" },
				{ type: "resource_link", name: "a.ts", uri: "file:///a.ts" },
				{ type: "image", data: "", mimeType: "image/png" },
			]),
		).toBe("hello\n[file: a.ts]\n[image]");
	});

	test("replay is verbatim transcript under optional character cap", () => {
		const text = buildHandoffPrompt({
			history: [
				{ role: "user", text: "fix the bug" },
				{ role: "assistant", text: "I found it" },
				{ role: "user", text: "continue" },
			],
		});
		expect(text).toBe("User:\nfix the bug\n\nAssistant:\nI found it\n\nUser:\ncontinue");
		expect(text.toLowerCase()).not.toContain("account");

		const entries = [
			{ role: "user" as const, text: "old".repeat(100) },
			{ role: "assistant" as const, text: "new".repeat(100) },
		];
		const capped = renderHistory(entries, 250);
		expect(capped).toContain("earlier turns omitted");
		expect(capped).toContain("new".repeat(100));
		expect(capped).not.toContain("old".repeat(100));
	});
});

describe("SessionLedger deep module", () => {
	test("keeps proxy↔child indices, load buffers, rebinds, and tombstones strictly in sync across saves", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agy-session-ledger-"));
		const path = join(dir, "acp-sessions.json");
		try {
			const ledger = new SessionLedger(path);
			await ledger.load();

			const session = ledger.create({
				profile: "acct-a",
				childSessionId: "child-1",
				cwd: "/repo",
				mcpServers: [],
				modelId: "gemini-3.8-flash",
				bufferPendingOut: true,
			});
			expect(ledger.get(session.id)).toBe(session);
			expect(ledger.getByChild("acct-a", "child-1")).toBe(session);

			// Load chunks buffer cleanly and flush into history.
			ledger.trackLoadChunk(session, "user", "hello ");
			ledger.trackLoadChunk(session, "user", "world");
			ledger.trackLoadChunk(session, "assistant", "hi back");
			ledger.flushLoadBuffers(session);
			expect(session.history).toEqual([
				{ role: "user", text: "hello world" },
				{ role: "assistant", text: "hi back" },
			]);

			// Atomic rebind moves child index from acct-a:child-1 to acct-b:child-2.
			const displaced = ledger.rebind(session, {
				profile: "acct-b",
				childSessionId: "child-2",
				needsHandoff: false,
				handoffSessionReady: true,
			});
			expect(displaced).toEqual({ previousProfile: "acct-a", previousChildId: "child-1" });
			expect(ledger.getByChild("acct-a", "child-1")).toBeUndefined();
			expect(ledger.getByChild("acct-b", "child-2")).toBe(session);

			await ledger.save();

			// Fresh ledger reloads persisted history & rebound mapping from disk.
			const reloaded = new SessionLedger(path);
			await reloaded.load();
			const restored = await reloaded.resolveOrLoad(session.id);
			expect(restored?.profile).toBe("acct-b");
			expect(restored?.childSessionId).toBe("child-2");
			expect(restored?.history).toEqual(session.history);

			// Fork copies history and registers a separate proxy session.
			const forked = reloaded.fork(restored!, "child-3");
			expect(forked.id).not.toBe(session.id);
			expect(forked.history).toEqual(session.history);
			expect(reloaded.getByChild("acct-b", "child-3")).toBe(forked);

			// Delete tombstones survive merge-on-save.
			reloaded.remove(session.id);
			await reloaded.save();
			const disk = await loadAcpSessions(path);
			expect(disk.sessions[session.id]).toBeUndefined();
			expect(disk.sessions[forked.id]?.childSessionId).toBe("child-3");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
