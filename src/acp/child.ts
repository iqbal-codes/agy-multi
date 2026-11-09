import { join } from "node:path";
import { profileDir } from "../paths";
import type { Profile } from "../types";
import { profileEnvOf, profileHomeOf } from "../registry";
import {
	isNotification,
	isRequest,
	isResponse,
	LineReader,
	LineWriter,
	parseJsonRpc,
	type JsonRpcErrorObject,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcRequest,
	type JsonRpcResponse,
} from "./rpc";

export interface AcpChildOptions {
	profile: Profile;
	agyBin: string;
	extraArgs: string[];
	log: (message: string) => void;
	onRequest: (child: AcpChild, request: JsonRpcRequest) => void;
	onNotification: (child: AcpChild, notification: JsonRpcMessage) => void;
	onExit: (child: AcpChild, code: number | null) => void;
}

interface PendingRequest {
	resolve: (response: JsonRpcResponse) => void;
	reject: (error: Error) => void;
	method: string;
}

/**
 * One `agy acp` process per profile. The process can host several sessions;
 * `loadedSessions` tracks which conversations this process actually has, so a
 * proxy restart or child crash can resume the right ones.
 */
export class AcpChild {
	readonly slug: string;
	readonly profile: Profile;
	/** Child session ids this exact process currently knows about. */
	readonly loadedSessions = new Set<string>();

	private readonly proc: ReturnType<typeof Bun.spawn>;
	private readonly writer: LineWriter;
	private readonly pending = new Map<string, PendingRequest>();
	private sequence = 0;
	private initializeResultValue: unknown;
	private initializePromise?: Promise<unknown>;
	private closed = false;
	private exitNotified = false;
	private exitCode: number | null = null;

	constructor(private readonly options: AcpChildOptions) {
		this.slug = options.profile.slug;
		this.profile = options.profile;

		const logPath = join(profileDir(this.slug), `acp-${process.pid}.log`);
		const args = [options.agyBin, "acp", "--log-file", logPath, ...options.extraArgs];
		const proc = Bun.spawn(args, {
			env: profileEnvOf(options.profile),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.proc = proc;

		const stdin = proc.stdin;
		const stdout = proc.stdout;
		const stderr = proc.stderr;
		if (!stdin || !stdout || !stderr) throw new Error(`failed to open pipes for agy acp (${this.slug})`);

		this.writer = new LineWriter(stdin);
		new LineReader(stdout, line => this.handleLine(line), () => this.handleExit());
		new LineReader(stderr, line => options.log(`[agy:${this.slug}] ${line}`));
		void proc.exited.then((code: number) => this.handleExit(code));
	}

	get alive(): boolean {
		return !this.closed;
	}

	get initialized(): boolean {
		return this.initializeResultValue !== undefined;
	}

	async initialize(params: unknown): Promise<unknown> {
		if (this.initializeResultValue !== undefined) return this.initializeResultValue;
		if (!this.initializePromise) {
			this.initializePromise = this.request("initialize", params).then(response => {
				if (response.error) throw new AcpRpcError(response.error);
				this.initializeResultValue = response.result;
				return response.result;
			});
		}
		return this.initializePromise;
	}

	request(method: string, params: unknown): Promise<JsonRpcResponse> {
		if (this.closed) return Promise.reject(new Error(`agent ${this.slug} is not running`));
		const id = `__agy_multi_${process.pid}_${++this.sequence}`;
		const { promise, resolve, reject } = Promise.withResolvers<JsonRpcResponse>();
		this.pending.set(id, { resolve, reject, method });
		this.writer.write({ jsonrpc: "2.0", id, method, params });
		return promise;
	}

	notify(method: string, params: unknown): void {
		if (this.closed) return;
		this.writer.write({ jsonrpc: "2.0", method, params });
	}

	respond(id: JsonRpcId | null, result: unknown): void {
		if (this.closed) return;
		this.writer.write({ jsonrpc: "2.0", id, result });
	}

	respondError(id: JsonRpcId | null, code: number, message: string, data?: unknown): void {
		if (this.closed) return;
		const error: JsonRpcErrorObject = { code, message, ...(data !== undefined ? { data } : {}) };
		this.writer.write({ jsonrpc: "2.0", id, error });
	}

	kill(): void {
		if (this.exitNotified) return;
		this.closed = true;
		try {
			this.proc.kill();
		} catch {
			// Already gone.
		}
		this.rejectPending(new Error(`agent ${this.slug} was stopped`));
	}

	private handleLine(line: string): void {
		const message = parseJsonRpc(line);
		if (!message) {
			this.options.log(`[agy:${this.slug}] non-protocol stdout: ${line.slice(0, 200)}`);
			return;
		}
		if (isResponse(message)) {
			const key = String(message.id);
			const pending = this.pending.get(key);
			if (pending) {
				this.pending.delete(key);
				pending.resolve(message);
				return;
			}
			this.options.log(`[agy:${this.slug}] unmatched response id=${key}`);
			return;
		}
		if (isRequest(message)) {
			this.options.onRequest(this, message);
			return;
		}
		if (isNotification(message)) {
			this.options.onNotification(this, message);
		}
	}

	private handleExit(code?: number | null): void {
		if (code !== undefined) this.exitCode = code;
		if (this.exitNotified) return;
		this.exitNotified = true;
		this.closed = true;
		this.rejectPending(new Error(`agent ${this.slug} exited`));
		this.options.onExit(this, this.exitCode);
	}

	private rejectPending(error: Error): void {
		for (const [key, pending] of this.pending) {
			pending.reject(error);
			this.pending.delete(key);
		}
	}
}

export class AcpRpcError extends Error {
	constructor(readonly rpcError: JsonRpcErrorObject) {
		super(rpcError.message);
		this.name = "AcpRpcError";
	}
}
