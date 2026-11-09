import { describe, expect, test } from "bun:test";
import { classifyRun } from "../src/classify";

describe("run classification", () => {
	test("success wins over noisy stderr", () => {
		expect(classifyRun("SUCCESS", "", "some warning")).toBe("ok");
	});

	test("ToS disable is a ban", () => {
		const stderr =
			'{"error":{"code":403,"status":"PERMISSION_DENIED","message":"This service has been disabled in this account for violation of Terms of Service."}}';
		expect(classifyRun(undefined, "", stderr)).toBe("banned");
	});

	test("quota exhaustion is retryable on another account", () => {
		expect(classifyRun(undefined, "", "RESOURCE_EXHAUSTED: quota exceeded")).toBe("quota");
	});

	test("missing login is auth", () => {
		expect(classifyRun(undefined, "", "You are not logged into Antigravity.")).toBe("auth");
	});

	test("network failure is transient, not a switch trigger", () => {
		expect(classifyRun(undefined, "", "read tcp: connection reset by peer (ECONNRESET)")).toBe("transient");
	});

	test("everything else is an error", () => {
		expect(classifyRun(undefined, "", "unexpected panic")).toBe("error");
	});
});
