/**
 * Minimal ACP JSON-RPC 2.0 stdio transport.
 *
 * ACP is newline-delimited JSON on both sides. This module deliberately does
 * not depend on the generated ACP schema; the proxy only needs message routing
 * and a few well-known method names, so unknown/future fields pass through.
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: JsonRpcId | null;
	result?: unknown;
	error?: JsonRpcErrorObject;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
	return "method" in message && typeof message.method === "string" && "id" in message;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
	return "method" in message && typeof message.method === "string" && !("id" in message);
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
	return !("method" in message) && "id" in message;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
	return typeof value === "string" || typeof value === "number";
}

/** Validate only the envelope fields the proxy routes on; params stay opaque. */
function isJsonRpcEnvelope(value: unknown): value is JsonRpcMessage {
	if (!value || typeof value !== "object") return false;
	if (!("jsonrpc" in value) || value.jsonrpc !== "2.0") return false;
	if ("method" in value) {
		if (typeof value.method !== "string") return false;
		return "id" in value ? isJsonRpcId(value.id) : true;
	}
	return "id" in value && (value.id === null || isJsonRpcId(value.id));
}

export function parseJsonRpc(line: string): JsonRpcMessage | undefined {
	try {
		const value: unknown = JSON.parse(line);
		if (isJsonRpcEnvelope(value)) return value;
	} catch {
		// ACP agents occasionally log to stdout; ignore non-protocol lines.
	}
	return undefined;
}

/** Reads newline-delimited UTF-8 lines from a web stream. */
export class LineReader {
	private buffer = "";
	private stopped = false;

	constructor(
		private readonly stream: ReadableStream<Uint8Array>,
		private readonly onLine: (line: string) => void,
		private readonly onClose?: () => void,
	) {
		void this.pump();
	}

	stop(): void {
		this.stopped = true;
	}

	private async pump(): Promise<void> {
		const reader = this.stream.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done || this.stopped) break;
				this.buffer += decoder.decode(value, { stream: true });
				let newline = this.buffer.indexOf("\n");
				while (newline >= 0) {
					const line = this.buffer.slice(0, newline).trim();
					this.buffer = this.buffer.slice(newline + 1);
					if (line) this.onLine(line);
					newline = this.buffer.indexOf("\n");
				}
			}
			const tail = this.buffer.trim();
			if (tail && !this.stopped) this.onLine(tail);
		} catch {
			// Stream aborted (process exit or client disconnect).
		} finally {
			this.onClose?.();
		}
	}
}

interface WritableSink {
	write(data: string): unknown;
	/** Bun FileSink.flush() may return a number or a promise. */
	flush?(): unknown;
}

/** Serializes writes so responses and streamed updates cannot interleave. */
export class LineWriter {
	private chain: Promise<void> = Promise.resolve();

	constructor(private readonly sink: WritableSink) {}

	write(message: unknown): void {
		const line = `${JSON.stringify(message)}\n`;
		this.chain = this.chain
			.then(async () => {
				this.sink.write(line);
				await this.sink.flush?.();
			})
			.catch(() => {
				// Broken pipe: the peer is gone; nothing useful to do.
			});
	}

	/** Resolves after all queued writes have been handed to the sink. */
	async drain(): Promise<void> {
		await this.chain;
	}
}
