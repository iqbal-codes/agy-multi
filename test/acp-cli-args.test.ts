import { describe, expect, test } from "bun:test";
import { parseAcpProxyOptions } from "../src/acp/cli-args";

describe("parseAcpProxyOptions", () => {
	test("defaults to account pool mode with sequential disabled", () => {
		const opts = parseAcpProxyOptions([]);
		expect(opts.sequential).toBe(false);
		expect(opts.extraArgs).toEqual([]);
	});

	test("strips legacy --allow-account-pool and enables sequential mode with --sequential", () => {
		const opts = parseAcpProxyOptions(["--allow-account-pool", "--sequential", "--switch-delay", "5"]);
		expect(opts.sequential).toBe(true);
		expect(opts.switchDelayMs).toBe(5000);
		expect(opts.extraArgs).toEqual([]);
	});

	test("enables sequential pool mode without requiring --allow-account-pool", () => {
		const opts = parseAcpProxyOptions(["--sequential"]);
		expect(opts.sequential).toBe(true);
	});
});
