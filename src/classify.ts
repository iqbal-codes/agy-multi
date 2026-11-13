import type { FailureKind } from "./types";

/**
 * Classify a finished `agy -p ... --output-format stream-json` run.
 *
 * Order matters: a ToS ban also carries PERMISSION_DENIED/403, and a quota
 * failure can mention 429. `/usage` still succeeds on banned accounts, so this
 * generation-time signal is the only reliable ban detector.
 */
export function classifyRun(resultStatus: string | undefined, stdout: string, stderr: string): FailureKind {
	if (resultStatus === "SUCCESS") return "ok";
	const text = `${stdout}\n${stderr}`;
	if (/violation of Terms of Service|service has been disabled in this account/i.test(text)) return "banned";
	if (/not logged into Antigravity|authentication required|authentication timed out|please log in/i.test(text)) {
		return "auth";
	}
	if (/RESOURCE_EXHAUSTED|quota|credit balance|429|limit reached|capacity/i.test(text)) return "quota";
	if (/502|503|504|timeout|timed out|network|ECONN|ETIMEDOUT|temporar|http2/i.test(text)) return "transient";
	return "error";
}

export function isRetryable(kind: FailureKind): boolean {
	return kind === "quota" || kind === "auth";
}

/**
 * Classify a JSON-RPC error returned by `agy acp`.
 *
 * ACP errors wrap the same transport failures as print mode, but may phrase
 * auth problems differently. Reuse the print-mode rules first so ban/quota
 * handling stays identical, then add ACP-specific auth wording.
 */
export function classifyAcpError(error: unknown): FailureKind {
	let text: string;
	try {
		text = typeof error === "string" ? error : JSON.stringify(error ?? "");
	} catch {
		text = String(error);
	}
	const base = classifyRun(undefined, text, "");
	if (base !== "error") return base;
	if (/not authenticated|unauthorized|login required|\b401\b/i.test(text)) return "auth";
	return "error";
}

/**
 * Detect whether an error indicates that the underlying agent lost
 * the conversation trajectory (e.g. trajectory not found, session not found).
 */
export function isSessionLostError(error: unknown): boolean {
	let text: string;
	try {
		text = typeof error === "string" ? error : JSON.stringify(error ?? "");
	} catch {
		text = String(error);
	}
	return /trajectory not found|session not found|unknown session|no such session|conversation not found|not_found:\s*trajectory/i.test(
		text,
	);
}

/**
 * Detect whether an error indicates the selected account/endpoint does not
 * support or recognize the requested model ID.
 */
export function isModelUnsupportedError(error: unknown): boolean {
	let text: string;
	try {
		text = typeof error === "string" ? error : JSON.stringify(error ?? "");
	} catch {
		text = String(error);
	}
	return /unknown model id|unsupported model|model\b[^.\n]*\bnot (?:found|supported|available)|does not support(?: the)? model/i.test(
		text,
	);
}
