import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadAcpSessions, saveAcpSessions } from "../src/acp/session-store";

describe("ACP session store", () => {
	test("round-trips atomic session records", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agy-multi-store-"));
		const path = join(dir, "acp-sessions.json");
		try {
			const empty = await loadAcpSessions(path);
			expect(empty.sessions).toEqual({});

			empty.sessions.s1 = {
				id: "s1",
				profile: "acct-a",
				childSessionId: "child-1",
				cwd: "/tmp",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			};
			await saveAcpSessions(empty, path);

			const loaded = await loadAcpSessions(path);
			expect(loaded.sessions.s1?.profile).toBe("acct-a");
			expect(loaded.sessions.s1?.childSessionId).toBe("child-1");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
