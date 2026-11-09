import { describe, expect, test } from "bun:test";
import { classifyAcpError } from "../src/classify";

describe("ACP error classification", () => {
	test("recognizes quota, ban and auth wording", () => {
		expect(classifyAcpError({ message: "RESOURCE_EXHAUSTED: quota exceeded" })).toBe("quota");
		expect(
			classifyAcpError({
				message: "This service has been disabled in this account for violation of Terms of Service",
			}),
		).toBe("banned");
		expect(classifyAcpError({ message: "authentication required" })).toBe("auth");
		expect(classifyAcpError({ message: "not authenticated" })).toBe("auth");
	});

	test("leaves unrelated failures alone", () => {
		expect(classifyAcpError({ message: "invalid params" })).toBe("error");
	});
});
