import { describe, expect, test } from "bun:test";
import { ensureAgy } from "../src/setup";

describe("ensureAgy helper", () => {
	test("returns existing agy executable when detected", async () => {
		const bin = await ensureAgy();
		expect(typeof bin).toBe("string");
		expect(bin.length).toBeGreaterThan(0);
	});
});
