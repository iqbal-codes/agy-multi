import { describe, expect, test } from "bun:test";
import { classifyAcpError, isModelUnsupportedError, isSessionLostError } from "../src/classify";

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

	test("recognizes lost session and trajectory errors", () => {
		expect(
			isSessionLostError({
				message:
					"Failed to send user message: not_found: trajectory not found: a36d8878-f2c8-4bae-8ccf-9f9c08f17f54: not found",
			}),
		).toBe(true);
		expect(isSessionLostError({ message: "not_found: trajectory not found: s1: not found" })).toBe(true);
		expect(isSessionLostError({ message: "unknown session" })).toBe(true);
		expect(isSessionLostError({ message: "session not found" })).toBe(true);
		expect(isSessionLostError({ message: "conversation not found" })).toBe(true);
		expect(isSessionLostError("unknown session: 12345")).toBe(true);
		expect(isSessionLostError({ message: "RESOURCE_EXHAUSTED: quota exceeded" })).toBe(false);
		expect(isSessionLostError({ message: "invalid params" })).toBe(false);
	});

	test("leaves unrelated failures alone", () => {
		expect(classifyAcpError({ message: "invalid params" })).toBe("error");
	});

	test("recognizes unsupported or unknown model errors", () => {
		expect(isModelUnsupportedError({ code: -32602, message: "Unknown model ID: gemini-4-hydrogen-high" })).toBe(true);
		expect(isModelUnsupportedError({ message: "Model gemini-4-argon is not supported for this account" })).toBe(true);
		expect(isModelUnsupportedError("model not found: gemini-4-hydrogen")).toBe(true);
		expect(isModelUnsupportedError({ message: "RESOURCE_EXHAUSTED: quota exceeded" })).toBe(false);
		expect(isModelUnsupportedError({ message: "invalid params" })).toBe(false);
	});
});
