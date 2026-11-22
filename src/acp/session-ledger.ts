import { randomUUID } from "node:crypto";
import { isRecord, readJson, writeJsonAtomic } from "../fs-utils";
import { ACP_SESSIONS_PATH } from "../paths";
import type { JsonRpcMessage } from "./rpc";

export interface HistoryEntry {
	role: "user" | "assistant";
	text: string;
}

/**
 * A proxy session id is what ACP clients see. It stays stable across account
 * switches; the child session id is the conversation id inside one profile.
 */
export interface AcpSessionRecord {
	id: string;
	profile: string;
	childSessionId: string;
	cwd: string;
	additionalDirectories?: string[];
	mcpServers?: unknown[];
	modelId?: string;
	history?: HistoryEntry[];
	needsHandoff?: boolean;
	handoffSessionReady?: boolean;
	/** Replay full history on handoff regardless of global `handoffContextChars` cap (used by emulated forks). */
	fullHandoffReplay?: boolean;
	title?: string;
	createdAt: string;
	updatedAt: string;
	closedAt?: string;
}

export interface AcpSessionStore {
	version: 1;
	sessions: Record<string, AcpSessionRecord>;
}

export interface TurnState {
	assistantText: string;
	forwardedOutput: boolean;
	suppressUserChunk: boolean;
	suppressOutput?: boolean;
	seenUsageUpdate?: boolean;
	/** Daemon tasks the mirrored tool calls referenced; the turn is held while any still runs. */
	daemonTasks: Map<string, { waitUntil?: number }>;
}

export interface SessionState {
	id: string;
	profile: string;
	childSessionId: string;
	cwd: string;
	additionalDirectories?: string[];
	mcpServers: unknown[];
	modelId?: string;
	history: HistoryEntry[];
	activeTurn?: TurnState;
	needsHandoff?: boolean;
	handoffSessionReady?: boolean;
	fullHandoffReplay?: boolean;
	loading?: boolean;
	suppressReplay?: boolean;
	cancelled?: boolean;
	loadBuffers?: { user: string; assistant: string; history: HistoryEntry[] };
	/** Updates received before the client saw `session/new`; flushed after it. */
	pendingOut?: unknown[];
	closed?: boolean;
	lastBroadcastedUsedTokens?: number;
	lastBroadcastCheckAt?: number;
	record: AcpSessionRecord;
}

export interface HandoffPromptOptions {
	/** Conversation the client already holds; replayed so the new session starts warm. */
	history: HistoryEntry[];
	/** Character budget for the replay; `0` or `undefined` replays everything. */
	maxChars?: number;
}

const EMPTY_STORE: AcpSessionStore = { version: 1, sessions: {} };

/**
 * Flatten an ACP ContentBlock into text suitable for history and handoff.
 * Embedded resources keep their text; links/images become short placeholders.
 */
export function contentBlockText(block: unknown): string {
	if (!isRecord(block)) return "";
	if (block.type === "text" && typeof block.text === "string") return block.text;
	if (block.type === "resource_link") {
		const title =
			typeof block.title === "string" ? block.title : typeof block.name === "string" ? block.name : undefined;
		const uri = typeof block.uri === "string" ? block.uri : undefined;
		return title || uri ? `[file: ${title ?? uri}]` : "";
	}
	if (block.type === "resource" && isRecord(block.resource)) {
		const resource = block.resource;
		if (typeof resource.text === "string" && resource.text) return resource.text;
		return typeof resource.uri === "string" ? `[resource: ${resource.uri}]` : "";
	}
	if (block.type === "image") return "[image]";
	if (block.type === "audio") return "[audio]";
	return "";
}

export function promptToText(prompt: unknown): string {
	if (!Array.isArray(prompt)) return "";
	return prompt
		.map(contentBlockText)
		.filter(part => part.length > 0)
		.join("\n");
}

/**
 * Render history for replay under a character budget. Newest turns are kept;
 * when the budget is exhausted the oldest surviving block is marked as omitted.
 */
export function renderHistory(entries: HistoryEntry[], maxChars = Number.POSITIVE_INFINITY): string {
	const blocks: string[] = [];
	let used = 0;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		const text = entry.text.trim();
		if (!text) continue;
		const block = `${entry.role === "user" ? "User" : "Assistant"}:\n${text}`;
		if (blocks.length > 0 && used + block.length > maxChars) {
			blocks.unshift("[earlier turns omitted]");
			break;
		}
		blocks.unshift(block);
		used += block.length;
	}
	return blocks.join("\n\n");
}

/**
 * Seeds a fresh backend session with the client's transcript verbatim —
 * no framing line, no account narrative, no synthesized tool markers.
 */
export function buildHandoffPrompt(options: HandoffPromptOptions): string {
	const maxChars = options.maxChars && options.maxChars > 0 ? options.maxChars : Number.POSITIVE_INFINITY;
	return renderHistory(options.history, maxChars);
}

export async function loadAcpSessions(path = ACP_SESSIONS_PATH): Promise<AcpSessionStore> {
	const store = await readJson<AcpSessionStore>(path, EMPTY_STORE);
	return { version: 1, sessions: store.sessions ?? {} };
}

export async function saveAcpSessions(
	store: AcpSessionStore,
	path = ACP_SESSIONS_PATH,
	deletedIds?: Set<string>,
): Promise<void> {
	const onDisk = await loadAcpSessions(path).catch(() => EMPTY_STORE);
	const mergedSessions: Record<string, AcpSessionRecord> = {
		...onDisk.sessions,
		...store.sessions,
	};
	if (deletedIds && deletedIds.size > 0) {
		for (const id of deletedIds) {
			delete mergedSessions[id];
		}
	}
	await writeJsonAtomic(path, { version: 1, sessions: mergedSessions });
}

function childKey(profile: string, childSessionId: string): string {
	return `${profile}\u0000${childSessionId}`;
}

/**
 * Deep module owning ACP session identity, synchronized proxy↔child indices,
 * load-replay/outbound buffering, handoff rebinding, and serialized atomic persistence.
 */
export class SessionLedger {
	private readonly sessions = new Map<string, SessionState>();
	private readonly sessionsByChild = new Map<string, SessionState>();
	private readonly unknownUpdates = new Map<string, JsonRpcMessage[]>();
	private readonly deletedSessionIds = new Set<string>();
	private store: AcpSessionStore = { version: 1, sessions: {} };
	private saveChain: Promise<void> = Promise.resolve();

	constructor(private readonly sessionsPath: string = ACP_SESSIONS_PATH) {}

	async load(): Promise<void> {
		this.store = await loadAcpSessions(this.sessionsPath);
	}

	get storedCount(): number {
		return Object.keys(this.store.sessions).length;
	}

	get(proxyId: string): SessionState | undefined {
		return this.sessions.get(proxyId);
	}

	getByChild(profile: string, childSessionId: string): SessionState | undefined {
		return this.sessionsByChild.get(childKey(profile, childSessionId));
	}

	getRecord(proxyId: string): AcpSessionRecord | undefined {
		return this.sessions.get(proxyId)?.record ?? this.store.sessions[proxyId];
	}

	values(): IterableIterator<SessionState> {
		return this.sessions.values();
	}

	/** The profile currently running an active turn, ignoring `exceptSlug`. */
	profileWithActiveTurn(exceptSlug?: string): string | undefined {
		for (const session of this.sessions.values()) {
			if (session.profile !== exceptSlug && session.activeTurn) return session.profile;
		}
		return undefined;
	}

	/** Create and index a brand-new proxy session. */
	create(options: {
		profile: string;
		childSessionId: string;
		cwd: string;
		mcpServers: unknown[];
		additionalDirectories?: string[];
		modelId?: string;
		bufferPendingOut?: boolean;
	}): SessionState {
		const id = randomUUID();
		const now = new Date().toISOString();
		const record: AcpSessionRecord = {
			id,
			profile: options.profile,
			childSessionId: options.childSessionId,
			cwd: options.cwd,
			...(options.additionalDirectories ? { additionalDirectories: options.additionalDirectories } : {}),
			mcpServers: options.mcpServers,
			createdAt: now,
			updatedAt: now,
		};
		const session: SessionState = {
			...record,
			mcpServers: options.mcpServers,
			history: [],
			record,
			...(options.modelId ? { modelId: options.modelId } : {}),
			...(options.bufferPendingOut ? { pendingOut: [] } : {}),
		};
		this.sessions.set(id, session);
		this.sessionsByChild.set(childKey(options.profile, options.childSessionId), session);
		this.store.sessions[id] = record;
		return session;
	}

	/** Resolve a session from memory, in-memory store, or latest disk store. */
	async resolveOrLoad(proxyId: string): Promise<SessionState | undefined> {
		let session = this.sessions.get(proxyId);
		if (session) return session;
		let record = this.store.sessions[proxyId];
		if (!record) {
			this.store = await loadAcpSessions(this.sessionsPath);
			record = this.store.sessions[proxyId];
		}
		if (!record) return undefined;
		session = {
			...record,
			mcpServers: record.mcpServers ?? [],
			history: [...(record.history ?? [])],
			record,
		};
		this.sessions.set(record.id, session);
		this.sessionsByChild.set(childKey(record.profile, record.childSessionId), session);
		return session;
	}

	/** Adopt an external session ID not yet present in the ledger. */
	adoptUnknown(options: {
		id: string;
		profile: string;
		cwd: string;
		mcpServers: unknown[];
		additionalDirectories?: string[];
	}): SessionState {
		const now = new Date().toISOString();
		const record: AcpSessionRecord = {
			id: options.id,
			profile: options.profile,
			childSessionId: options.id,
			cwd: options.cwd,
			...(options.additionalDirectories ? { additionalDirectories: options.additionalDirectories } : {}),
			mcpServers: options.mcpServers,
			createdAt: now,
			updatedAt: now,
		};
		const session: SessionState = {
			...record,
			mcpServers: options.mcpServers,
			history: [],
			record,
		};
		this.sessions.set(options.id, session);
		this.sessionsByChild.set(childKey(options.profile, options.id), session);
		this.store.sessions[options.id] = record;
		return session;
	}

	/** Roll back an `adoptUnknown` entry when the child rejects load/resume. */
	rollbackUnknown(session: SessionState): void {
		session.loadBuffers = undefined;
		this.sessions.delete(session.id);
		this.sessionsByChild.delete(childKey(session.profile, session.childSessionId));
		delete this.store.sessions[session.id];
	}

	/** Fork an existing session into a new proxy ID with copied history and metadata. */
	fork(
		source: SessionState,
		childSessionId: string,
		modelId?: string,
		options?: {
			needsHandoff?: boolean;
			handoffSessionReady?: boolean;
			fullHandoffReplay?: boolean;
			bufferPendingOut?: boolean;
		},
	): SessionState {
		const now = new Date().toISOString();
		const id = randomUUID();
		const additionalDirectories = source.additionalDirectories ? [...source.additionalDirectories] : undefined;
		const mcpServers = [...source.mcpServers];
		const history = source.history.map(entry => ({ ...entry }));
		const resolvedModelId = modelId ?? source.modelId;
		const record: AcpSessionRecord = {
			id,
			profile: source.profile,
			childSessionId,
			cwd: source.cwd,
			...(additionalDirectories ? { additionalDirectories } : {}),
			mcpServers,
			...(resolvedModelId ? { modelId: resolvedModelId } : {}),
			history,
			...(options?.needsHandoff !== undefined ? { needsHandoff: options.needsHandoff } : {}),
			...(options?.handoffSessionReady !== undefined ? { handoffSessionReady: options.handoffSessionReady } : {}),
			...(options?.fullHandoffReplay !== undefined ? { fullHandoffReplay: options.fullHandoffReplay } : {}),
			createdAt: now,
			updatedAt: now,
		};
		const forked: SessionState = {
			...record,
			mcpServers,
			history,
			modelId: resolvedModelId,
			...(options?.bufferPendingOut ? { pendingOut: [] } : {}),
			record,
		};
		this.sessions.set(id, forked);
		this.sessionsByChild.set(childKey(source.profile, childSessionId), forked);
		this.store.sessions[id] = record;
		return forked;
	}

	/**
	 * Atomically rebind a proxy session to a new profile and/or child session ID,
	 * keeping `sessions`, `sessionsByChild`, and `record` strictly in sync.
	 */
	rebind(
		session: SessionState,
		next: {
			profile: string;
			childSessionId: string;
			needsHandoff?: boolean;
			handoffSessionReady?: boolean;
			fullHandoffReplay?: boolean;
		},
	): { previousProfile: string; previousChildId: string } {
		const previousProfile = session.profile;
		const previousChildId = session.childSessionId;
		this.sessionsByChild.delete(childKey(previousProfile, previousChildId));

		session.profile = next.profile;
		session.childSessionId = next.childSessionId;
		session.record.profile = next.profile;
		session.record.childSessionId = next.childSessionId;
		session.record.updatedAt = new Date().toISOString();
		if (next.needsHandoff !== undefined) session.needsHandoff = next.needsHandoff;
		if (next.handoffSessionReady !== undefined) session.handoffSessionReady = next.handoffSessionReady;
		if (next.fullHandoffReplay !== undefined) session.fullHandoffReplay = next.fullHandoffReplay;

		this.sessionsByChild.set(childKey(next.profile, next.childSessionId), session);
		return { previousProfile, previousChildId };
	}

	/** Re-index an existing session's child key (e.g. after `session/resume` on a fresh child). */
	bindChild(session: SessionState): void {
		this.sessionsByChild.set(childKey(session.profile, session.childSessionId), session);
	}

	/** Mark a session closed (retaining history for future resume). */
	close(proxyId: string): AcpSessionRecord | undefined {
		const session = this.sessions.get(proxyId);
		const record = session?.record ?? this.store.sessions[proxyId];
		if (!record) return undefined;
		record.closedAt = new Date().toISOString();
		record.updatedAt = record.closedAt;
		if (session) session.closed = true;
		return record;
	}

	/** Delete a session from memory and tombstone it for cross-process merge persistence. */
	remove(proxyId: string): AcpSessionRecord | undefined {
		const session = this.sessions.get(proxyId);
		const record = session?.record ?? this.store.sessions[proxyId];
		if (!record) return undefined;
		this.deletedSessionIds.add(record.id);
		delete this.store.sessions[record.id];
		this.sessions.delete(record.id);
		this.sessionsByChild.delete(childKey(record.profile, record.childSessionId));
		return record;
	}

	/** Paginated `session/list` view from stored records. */
	list(options: { cwd?: string; cursor?: string; limit?: number } = {}): {
		sessions: Array<{
			sessionId: string;
			cwd: string;
			additionalDirectories?: string[];
			title: string | null;
			updatedAt: string | null;
		}>;
		nextCursor: string | null;
	} {
		const parsed = options.cursor ? Number.parseInt(options.cursor, 10) : 0;
		const start = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
		const limit = options.limit ?? 100;
		const all = Object.values(this.store.sessions)
			.filter(record => !options.cwd || record.cwd === options.cwd)
			.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
		const page = all.slice(start, start + limit);
		return {
			sessions: page.map(record => ({
				sessionId: record.id,
				cwd: record.cwd,
				...(record.additionalDirectories ? { additionalDirectories: record.additionalDirectories } : {}),
				title: record.title ?? null,
				updatedAt: record.updatedAt ?? null,
			})),
			nextCursor: start + limit < all.length ? String(start + limit) : null,
		};
	}

	/** Buffer up to 100 notifications arriving before `session/new` registers the child session ID. */
	bufferUnknownUpdate(profile: string, childSessionId: string, message: JsonRpcMessage): void {
		const key = childKey(profile, childSessionId);
		const buffered = this.unknownUpdates.get(key) ?? [];
		if (buffered.length < 100) buffered.push(message);
		this.unknownUpdates.set(key, buffered);
	}

	takeUnknownUpdates(profile: string, childSessionId: string): JsonRpcMessage[] {
		const key = childKey(profile, childSessionId);
		const buffered = this.unknownUpdates.get(key);
		if (!buffered) return [];
		this.unknownUpdates.delete(key);
		return buffered;
	}

	trackLoadChunk(session: SessionState, role: "user" | "assistant", text: string): void {
		if (!text) return;
		session.loadBuffers ??= { user: "", assistant: "", history: [] };
		const buffers = session.loadBuffers;
		if (role === "user") {
			if (buffers.assistant) {
				buffers.history.push({ role: "assistant", text: buffers.assistant });
				buffers.assistant = "";
			}
			buffers.user += text;
		} else {
			if (buffers.user) {
				buffers.history.push({ role: "user", text: buffers.user });
				buffers.user = "";
			}
			buffers.assistant += text;
		}
	}

	flushLoadBuffers(session: SessionState): void {
		if (!session.loadBuffers) return;
		const buffers = session.loadBuffers;
		if (buffers.user) buffers.history.push({ role: "user", text: buffers.user });
		if (buffers.assistant) buffers.history.push({ role: "assistant", text: buffers.assistant });
		// Child replay covers only the current account, not earlier handoffs.
		if (!session.history.length) session.history = buffers.history;
		session.loadBuffers = undefined;
	}

	drainPendingOut(session: SessionState, sink: (message: unknown) => void): void {
		const pending = session.pendingOut;
		session.pendingOut = undefined;
		if (pending) {
			for (const message of pending) sink(message);
		}
	}

	/** Snapshot live session state and enqueue an atomic merge-and-write to disk. */
	save(): Promise<void> {
		for (const session of this.sessions.values()) {
			session.record.history = [...session.history];
			session.record.modelId = session.modelId;
			session.record.needsHandoff = session.needsHandoff;
			session.record.handoffSessionReady = session.handoffSessionReady;
			session.record.fullHandoffReplay = session.fullHandoffReplay;
		}
		const snapshot = structuredClone(this.store);
		const deleted = new Set(this.deletedSessionIds);
		const next = this.saveChain.then(() => saveAcpSessions(snapshot, this.sessionsPath, deleted));
		// The caller sees this write's failure; the chain stays usable for later writes.
		this.saveChain = next.catch(() => {});
		return next;
	}
}
