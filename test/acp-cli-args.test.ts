import { describe, expect, test } from "bun:test";
import { extractCompactionThresholdArg, extractFlagArg, parseAcpProxyOptions } from "../src/acp/cli-args";

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

	test("extracts --compaction-threshold and generic flags cleanly from argv", () => {
		expect(extractCompactionThresholdArg(["--foo", "bar"])).toEqual({
			threshold: undefined,
			remainingArgs: ["--foo", "bar"],
		});
		expect(extractCompactionThresholdArg(["--compaction-threshold", "250000", "--clean"])).toEqual({
			threshold: 250_000,
			remainingArgs: ["--clean"],
		});
		expect(extractCompactionThresholdArg(["--foo", "--compaction-threshold=400000", "--bar"])).toEqual({
			threshold: 400_000,
			remainingArgs: ["--foo", "--bar"],
		});
		expect(extractFlagArg(["--switch-delay=0", "--foo"], "--switch-delay")).toEqual({
			value: "0",
			rest: ["--foo"],
		});
	});

	test("parses --clean without --disable-slash-commands and recognizes --include-default-customizations=false", () => {
		const cleanOpts = parseAcpProxyOptions(["--clean"]);
		expect(cleanOpts.clean).toBe(true);
		expect(cleanOpts.extraArgs).toEqual(["--include-default-customizations=false"]);
		expect(cleanOpts.extraArgs).not.toContain("--disable-slash-commands");

		const passthroughOpts = parseAcpProxyOptions(["--", "--dangerously-skip-permissions", "--include-default-customizations=false"]);
		expect(passthroughOpts.clean).toBe(true);
		expect(passthroughOpts.extraArgs).toEqual(["--dangerously-skip-permissions", "--include-default-customizations=false"]);
	});

	test("parses comma-separated and repeated --skills flags", () => {
		const opts = parseAcpProxyOptions(["--clean", "--skills", "alpha, beta", "--skills=gamma"]);
		expect(opts.clean).toBe(true);
		expect(opts.skills).toEqual(["alpha", "beta", "gamma"]);
		expect(opts.extraArgs).toEqual(["--include-default-customizations=false"]);
	});
});
