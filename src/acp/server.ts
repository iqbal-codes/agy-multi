import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { classifyAcpError, isModelUnsupportedError, isSessionLostError } from "../classify";
import { exists, run } from "../fs-utils";
import {
	AGY_BIN,
	ACP_SESSIONS_PATH,
	DEFAULT_BLOCK_MS,
	DEFAULT_RESERVE_PCT,
	MODELS_TTL_MS,
	USAGE_TTL_MS,
	profileHome,
} from "../paths";
import { listProfiles, profileHomeOf, saveProfile } from "../registry";
import { block, isBlocked, loadState, saveState } from "../state";
import { rankProfiles } from "../select";
import { syncProfiles } from "../profile";
import { listUserSkills } from "../injection";
import type { FailureKind, Family, ModelsSnapshot, Profile, UsageSnapshot, WrapperState } from "../types";
import { blockingReset, familyForModel, fetchUsage, minRemaining, readCachedUsage } from "../usage";
import {
	deriveBaseConfigOptions,
	extractAcpModelsFromResult,
	fetchModels,
	isModelKnownUnsupported,
	mergeConfigOptionLists,
	mergeModelLists,
	readCachedModels,
	withoutUnsupportedModel,
	writeCachedModels,
} from "../models";
import { AcpChild, AcpRpcError } from "./child";
import {
	DAEMON_HOLD_MAX_CONTINUATIONS,
	DAEMON_HOLD_MAX_MS,
	applyDaemonSignal,
	daemonHoldPrompt,
	daemonTaskSignal,
	nextWaitMs,
} from "./daemon-tasks";
import { isRecord } from "./guards";
import { buildHandoffPrompt, promptToText, toolTitle, type HistoryEntry } from "./prompt";
import {
	isNotification,
	isRequest,
	isResponse,
	LineReader,
	LineWriter,
	parseJsonRpc,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
} from "./rpc";
import { loadAcpSessions, saveAcpSessions, type AcpSessionRecord, type AcpSessionStore } from "./session-store";
import {
	resolveCompactionThreshold,
	resolveSessionTokenUsage,
	resolveModelContextWindow,
	DEFAULT_COMPACTION_THRESHOLD,
} from "./token-usage";

export interface AcpProxyOptions {
	agyBin?: string;
	extraArgs?: string[];
	maxSwitches?: number;
	reservePct?: number;
	compactionThreshold?: number;
	sessionsPath?: string;
	log?: (line: string) => void;
}

interface TurnState {
	assistantText: string;
	toolTitles: string[];
	forwardedOutput: boolean;
	suppressUserChunk: boolean;
	suppressOutput?: boolean;
	seenUsageUpdate?: boolean;
	/** Daemon tasks the mirrored tool calls referenced; the turn is held while any still runs. */
	daemonTasks: Map<string, { waitUntil?: number }>;
}

interface SessionState {
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

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((item): item is string => typeof item === "string");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * ACP server that fronts several isolated `agy acp` processes.
 *
 * It is a real JSON-RPC router: client requests are answered by the proxy,
 * agent requests (permissions, fs, terminal) are forwarded with rewritten ids,
 * and `session/prompt` failures can move the conversation to another account
 * with a handoff prompt. The official binary and protocol are untouched.
 */
class AcpProxy {
	private readonly agyBin: string;
	private readonly extraArgs: string[];
	private readonly maxSwitches: number;
	private readonly reservePct: number;
	private readonly compactionThreshold: number;
	private readonly sessionsPath: string;
	private readonly log: (line: string) => void;
	private readonly out: LineWriter;

	private readonly children = new Map<string, AcpChild>();
	private readonly sessions = new Map<string, SessionState>();
	private readonly sessionsByChild = new Map<string, SessionState>();
	private readonly agentRequests = new Map<string, { child: AcpChild; id: JsonRpcId }>();
	private readonly unknownUpdates = new Map<string, JsonRpcMessage[]>();
	private readonly usageCache = new Map<string, { snapshot: UsageSnapshot | null; at: number }>();
	private readonly usageInflight = new Map<string, Promise<UsageSnapshot | null>>();
	private readonly modelsCache = new Map<string, { snapshot: ModelsSnapshot | null; at: number }>();
	private readonly modelsInflight = new Map<string, Promise<ModelsSnapshot | null>>();
	private readonly usageAbort = new AbortController();
	private readonly deletedSessionIds = new Set<string>();

	private profiles = new Map<string, Profile>();
	private state: WrapperState = { version: 1, pins: {}, blocks: {}, checkpoints: {} };
	private store: AcpSessionStore = { version: 1, sessions: {} };
	private clientInitialize?: unknown;
	private controlChild?: AcpChild;
	private agentRequestSeq = 0;
	private shuttingDown = false;
	private saveChain: Promise<void> = Promise.resolve();

	constructor(options: AcpProxyOptions = {}) {
		this.agyBin = options.agyBin ?? AGY_BIN;
		this.extraArgs = options.extraArgs ?? [];
		this.maxSwitches = options.maxSwitches ?? 3;
		this.reservePct = options.reservePct ?? DEFAULT_RESERVE_PCT;
		this.compactionThreshold = resolveCompactionThreshold(options.compactionThreshold);
		this.sessionsPath = options.sessionsPath ?? ACP_SESSIONS_PATH;
		this.log = options.log ?? (line => process.stderr.write(`[agy-multi acp] ${line}\n`));
		this.out = new LineWriter({ write: line => process.stdout.write(line) });
	}

	async start(): Promise<void> {
		this.profiles = new Map((await listProfiles()).map(profile => [profile.slug, profile]));
		this.state = await loadState();
		this.store = await loadAcpSessions(this.sessionsPath);
		await Promise.all(
			[...this.profiles.values()].map(async profile => {
				const [diskCached, diskModels] = await Promise.all([
					readCachedUsage(profile.slug),
					readCachedModels(profile.slug),
				]);
				if (diskCached) {
					this.usageCache.set(profile.slug, { snapshot: diskCached, at: diskCached.fetchedAt });
				}
				if (diskModels) {
					this.modelsCache.set(profile.slug, { snapshot: diskModels, at: diskModels.fetchedAt });
				}
			}),
		);
		this.log(
			`ready — ${this.profiles.size} profile(s), ${Object.keys(this.store.sessions).length} stored session(s), auto-compaction threshold: ${this.compactionThreshold > 0 ? `${this.compactionThreshold} tokens` : "disabled"}`,
		);

		new LineReader(
			Bun.stdin.stream(),
			line => {
				const message = parseJsonRpc(line);
				if (!message) {
					this.log(`non-protocol stdin: ${line.slice(0, 200)}`);
					return;
				}
				this.handleClientMessage(message);
			},
			() => this.shutdown(),
		);
		process.on("SIGTERM", () => this.shutdown());
		process.on("SIGINT", () => this.shutdown());
	}

	private shutdown(): void {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		this.usageAbort.abort();
		for (const child of this.children.values()) child.kill();
		this.children.clear();
		process.exit(0);
	}

	private sendToClient(message: unknown): void {
		this.out.write(message);
	}

	private respond(id: JsonRpcId, result: unknown): void {
		this.sendToClient({ jsonrpc: "2.0", id, result });
	}

	private respondError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
		this.sendToClient({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
	}

	private respondFailure(id: JsonRpcId, error: unknown): void {
		if (error instanceof AcpRpcError) {
			this.respondError(id, error.rpcError.code, error.rpcError.message, error.rpcError.data);
			return;
		}
		this.respondError(id, -32603, errorMessage(error));
	}

	// ---------------------------------------------------------------------
	// Client message dispatch
	// ---------------------------------------------------------------------

	private handleClientMessage(message: JsonRpcMessage): void {
		if (isResponse(message)) {
			this.handleClientResponse(message);
			return;
		}
		if (isRequest(message)) {
			void this.handleClientRequest(message);
			return;
		}
		if (isNotification(message)) this.handleClientNotification(message);
	}

	private async handleClientRequest(request: JsonRpcRequest): Promise<void> {
		try {
			switch (request.method) {
				case "initialize":
					return await this.onInitialize(request);
				case "authenticate":
					return await this.onAuthenticate(request);
				case "session/new":
					return await this.onSessionNew(request);
				case "session/load":
					return await this.onSessionLoad(request, false);
				case "session/resume":
					return await this.onSessionLoad(request, true);
				case "session/list":
					return this.onSessionList(request);
				case "session/close":
					return await this.onSessionClose(request, false);
				case "session/delete":
					return await this.onSessionClose(request, true);
				case "session/fork":
					return await this.onSessionFork(request);
				case "session/prompt":
					this.onSessionPrompt(request);
					return;
				default:
					return await this.onGenericRequest(request);
			}
		} catch (error) {
			this.respondFailure(request.id, error);
		}
	}

	private handleClientResponse(response: JsonRpcResponse): void {
		const key = String(response.id);
		const pending = this.agentRequests.get(key);
		if (!pending) {
			this.log(`unmatched client response id=${key}`);
			return;
		}
		this.agentRequests.delete(key);
		if (response.error) {
			pending.child.respondError(pending.id, response.error.code, response.error.message, response.error.data);
		} else {
			pending.child.respond(pending.id, response.result);
		}
	}

	private handleClientNotification(notification: JsonRpcNotification): void {
		const params = isRecord(notification.params) ? notification.params : undefined;
		if (notification.method === "session/cancel") {
			const sessionId = params ? readString(params.sessionId) : undefined;
			const session = sessionId ? this.sessions.get(sessionId) : undefined;
			if (!session) return;
			session.cancelled = true;
			const child = this.children.get(session.profile);
			if (child?.alive) child.notify("session/cancel", { sessionId: session.childSessionId });
			return;
		}

		const sessionId = params ? readString(params.sessionId) : undefined;
		const session = sessionId ? this.sessions.get(sessionId) : undefined;
		if (session) {
			const child = this.children.get(session.profile);
			if (child?.alive) {
				child.notify(notification.method, { ...(params ?? {}), sessionId: session.childSessionId });
			}
			return;
		}
		const child = this.controlChild?.alive ? this.controlChild : undefined;
		if (child) child.notify(notification.method, notification.params);
	}

	// ---------------------------------------------------------------------
	// Agent message dispatch
	// ---------------------------------------------------------------------

	private handleAgentNotification(child: AcpChild, message: JsonRpcMessage): void {
		if (!isNotification(message)) return;
		const params = isRecord(message.params) ? message.params : undefined;
		const childSessionId = params ? readString(params.sessionId) : undefined;
		if (!childSessionId) {
			this.log(`[agy:${child.slug}] update without sessionId`);
			return;
		}
		const key = this.childKey(child.slug, childSessionId);
		const session = this.sessionsByChild.get(key);
		if (!session) {
			const buffered = this.unknownUpdates.get(key) ?? [];
			if (buffered.length < 100) buffered.push(message);
			this.unknownUpdates.set(key, buffered);
			return;
		}

		const outParams = { ...(params ?? {}), sessionId: session.id };
		const outMessage = { ...message, params: outParams };
		const deliver = (value: unknown): void => {
			if (session.suppressReplay) return;
			if (session.pendingOut) session.pendingOut.push(value);
			else this.sendToClient(value);
		};

		const update = params && isRecord(params.update) ? params.update : undefined;
		if (!update) {
			deliver(outMessage);
			return;
		}

		const kind = readString(update.sessionUpdate);
		const content = isRecord(update.content) ? update.content : undefined;
		const text = content && typeof content.text === "string" ? content.text : "";

		if (kind === "agent_message_chunk") {
			if (session.activeTurn) {
				session.activeTurn.assistantText += text;
				if (text) session.activeTurn.forwardedOutput = true;
			} else if (session.loading) {
				this.trackLoadChunk(session, "assistant", text);
			}
			if (session.activeTurn?.suppressOutput) return;
			deliver(outMessage);
			this.maybeBroadcastRealtimeUsage(session);
			return;
		}
		if (kind === "agent_thought_chunk") {
			if (session.activeTurn) session.activeTurn.forwardedOutput = true;
			if (session.activeTurn?.suppressOutput) return;
			deliver(outMessage);
			this.maybeBroadcastRealtimeUsage(session);
			return;
		}
		if (kind === "user_message_chunk") {
			if (session.loading) this.trackLoadChunk(session, "user", text);
			if (session.activeTurn?.suppressUserChunk || session.activeTurn?.suppressOutput) return;
			deliver(outMessage);
			return;
		}
		if (kind === "tool_call" || kind === "tool_call_update") {
			if (session.activeTurn) {
				session.activeTurn.forwardedOutput = true;
				if (kind === "tool_call") {
					const title = toolTitle(update);
					if (title) session.activeTurn.toolTitles.push(title);
				}
				const signal = daemonTaskSignal(update, Date.now());
				applyDaemonSignal(session.activeTurn.daemonTasks, signal);
			}
			if (session.activeTurn?.suppressOutput) return;
			deliver(outMessage);
			this.maybeBroadcastRealtimeUsage(session, true);
			return;
		}
		if (kind === "plan") {
			if (session.activeTurn) session.activeTurn.forwardedOutput = true;
			if (session.activeTurn?.suppressOutput) return;
			deliver(outMessage);
			this.maybeBroadcastRealtimeUsage(session, true);
			return;
		}
		if (kind === "session_info_update") {
			const title = readString(update.title);
			if (title) {
				session.record.title = title;
				session.record.updatedAt = new Date().toISOString();
				void this.saveStore().catch(error => this.log(`failed to persist session title: ${errorMessage(error)}`));
			}
			deliver(outMessage);
			return;
		}
		if (kind === "usage_update") {
			if (session.activeTurn) session.activeTurn.seenUsageUpdate = true;
			deliver(outMessage);
			return;
		}
		if (kind === "available_commands_update") {
			const commands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
			const augmented = this.buildAvailableCommands(session.cwd, commands);
			const augmentedUpdate = { ...update, availableCommands: augmented };
			deliver({ ...outMessage, params: { ...outParams, update: augmentedUpdate } });
			return;
		}
		deliver(outMessage);
	}

	private handleAgentRequest(child: AcpChild, request: JsonRpcRequest): void {
		const params = isRecord(request.params) ? request.params : undefined;
		const childSessionId = params ? readString(params.sessionId) : undefined;
		const session = childSessionId ? this.sessionsByChild.get(this.childKey(child.slug, childSessionId)) : undefined;
		const proxyId = `__agy_agent_${++this.agentRequestSeq}`;
		this.agentRequests.set(proxyId, { child, id: request.id });
		const outParams = params && session ? { ...params, sessionId: session.id } : request.params;
		this.sendToClient({
			jsonrpc: "2.0",
			id: proxyId,
			method: request.method,
			...(outParams !== undefined ? { params: outParams } : {}),
		});
	}

	private failPendingAgentRequests(child: AcpChild): void {
		for (const [proxyId, pending] of this.agentRequests) {
			if (pending.child !== child) continue;
			this.agentRequests.delete(proxyId);
			this.sendToClient({ jsonrpc: "2.0", id: proxyId, error: { code: -32603, message: "agent exited" } });
		}
	}

	private buildAvailableCommands(cwd?: string, childCommands: unknown[] = []): Array<{ name: string; description?: string; input?: { hint?: string } }> {
		const seen = new Set<string>();
		const result: Array<{ name: string; description?: string; input?: { hint?: string } }> = [];

		const add = (name: string, description?: string, hint?: string) => {
			const key = name.toLowerCase();
			if (seen.has(key)) return;
			seen.add(key);
			result.push({
				name,
				...(description ? { description } : {}),
				...(hint ? { input: { hint } } : {}),
			});
		};

		// Recognized system slash commands (these must remain slash commands without $)
		const SYSTEM_SLASH_COMMANDS = new Set([
			"plan",
			"default",
			"compact",
			"clear",
			"goal",
			"learn",
			"browser",
			"teamwork",
			"boost",
			"grill-me",
			"schedule",
			"side",
			"btw",
		]);

		// Standard system commands with descriptions
		const STANDARD_COMMANDS = [
			{ name: "plan", description: "Switch this thread into plan mode" },
			{ name: "default", description: "Switch this thread back to normal build mode" },
			{ name: "compact", description: "Compact conversation history to free context window" },
			{ name: "clear", description: "Start a fresh session; earlier messages stay visible" },
			{ name: "goal", description: "Run a long-running task until goal is fully achieved" },
			{ name: "learn", description: "Save persistent learnings into memory/rules" },
			{ name: "browser", description: "Web browsing and web application interaction mode" },
			{ name: "teamwork", description: "Team of autonomous agents working together" },
			{ name: "boost", description: "Deep thinking, strategic planning, and rigorous verification" },
			{ name: "grill-me", description: "Interactive interview to resolve design decisions" },
			{ name: "schedule", description: "Run an instruction on a recurring schedule or as a timer" },
		];

		// 1. Prioritize adding essential system slash commands first (so they are never truncated)
		for (const std of STANDARD_COMMANDS) {
			add(std.name, std.description);
		}

		// 2. All skills strictly from the primary user home directory (~/.gemini/...) prefixed with $
		const skills = listUserSkills(cwd);
		for (const skill of skills) {
			add(`$${skill.name}`, skill.description);
		}

		// 3. Child commands (from agy acp)
		// Note: agy acp sends skills as bare names without $. If a child command is NOT a system slash command,
		// it is a skill and MUST be prefixed with $ so T3 Code maps it to skills ($), not slash commands (/).
		for (const cmd of childCommands) {
			if (isRecord(cmd) && typeof cmd.name === "string") {
				const name = cmd.name.trim();
				if (!name) continue;
				const desc = typeof cmd.description === "string" ? cmd.description : undefined;
				const hint = isRecord(cmd.input) && typeof cmd.input.hint === "string" ? cmd.input.hint : undefined;

				const lower = name.toLowerCase();
				if (name.startsWith("$")) {
					add(name, desc, hint);
				} else if (SYSTEM_SLASH_COMMANDS.has(lower)) {
					add(name, desc, hint);
				} else {
					// It's a skill published by agy acp without $ -> add as skill with $
					add(`$${name}`, desc, hint);
				}
			}
		}

		return result;
	}

	private broadcastAvailableCommands(session: SessionState): void {
		const commands = this.buildAvailableCommands(session.cwd);
		this.sendToClient({
			jsonrpc: "2.0",
			method: "session/update",
			params: {
				sessionId: session.id,
				update: {
					sessionUpdate: "available_commands_update",
					availableCommands: commands,
				},
			},
		});
	}

	private maybeBroadcastRealtimeUsage(session: SessionState, immediate = false): void {
		if (session.loading || session.activeTurn?.suppressOutput || session.activeTurn?.seenUsageUpdate) return;
		const now = Date.now();
		if (!immediate && now - (session.lastBroadcastCheckAt ?? 0) < 500) {
			return;
		}
		session.lastBroadcastCheckAt = now;
		this.broadcastUsageUpdate(session);
	}

	private broadcastUsageUpdate(session: SessionState, profile?: Profile): void {
		const targetProfile = profile ?? this.profiles.get(session.profile);
		if (!targetProfile) return;
		const profileHome = profileHomeOf(targetProfile);
		const usage = resolveSessionTokenUsage(profileHome, session.childSessionId);
		if (!usage) return;
		if (usage.usedTokens === session.lastBroadcastedUsedTokens) return;
		session.lastBroadcastedUsedTokens = usage.usedTokens;
		const maxTokens = resolveModelContextWindow(session.modelId);
		this.sendToClient({
			jsonrpc: "2.0",
			method: "session/update",
			params: {
				sessionId: session.id,
				update: {
					sessionUpdate: "usage_update",
					used: usage.usedTokens,
					size: maxTokens,
				},
			},
		});
	}

	// ---------------------------------------------------------------------
	// Child lifecycle
	// ---------------------------------------------------------------------

	private async ensureChild(profile: Profile): Promise<AcpChild> {
		const existing = this.children.get(profile.slug);
		if (existing?.alive) return existing;
		existing?.kill();
		const child = new AcpChild({
			profile,
			agyBin: this.agyBin,
			extraArgs: this.extraArgs,
			log: this.log,
			onRequest: (source, request) => this.handleAgentRequest(source, request),
			onNotification: (source, notification) => this.handleAgentNotification(source, notification),
			onExit: source => {
				if (this.children.get(profile.slug) === source) this.children.delete(profile.slug);
				this.failPendingAgentRequests(source);
			},
		});
		this.children.set(profile.slug, child);
		return child;
	}

	private getHealthyProfiles(preferred?: string[]): Profile[] {
		const now = Date.now();
		const candidates = [...this.profiles.values()].filter(
			p => !p.bannedAt && !p.authRequiredAt && !p.disabled,
		);
		candidates.sort((a, b) => {
			if (preferred?.length) {
				const aPref = preferred.includes(a.slug);
				const bPref = preferred.includes(b.slug);
				if (aPref !== bPref) return aPref ? -1 : 1;
			}
			const aBlocked = isBlocked(this.state, a.slug, "gemini", now);
			const bBlocked = isBlocked(this.state, b.slug, "gemini", now);
			if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;
			if (a.slug === "main") return -1;
			if (b.slug === "main") return 1;
			const aOk = a.lastGenerationOkAt ? Date.parse(a.lastGenerationOkAt) : 0;
			const bOk = b.lastGenerationOkAt ? Date.parse(b.lastGenerationOkAt) : 0;
			return bOk - aOk;
		});
		return candidates;
	}

	private async ensureControlChild(): Promise<AcpChild> {
		if (this.controlChild?.alive) return this.controlChild;
		const candidates = this.getHealthyProfiles();
		const profile = candidates[0];
		if (!profile) throw new Error("no profiles configured; add one with `agy-multi profile add <slug>`");
		const child = await this.ensureChild(profile);
		await child.initialize(this.clientInitialize);
		this.controlChild = child;
		return child;
	}

	private async ensureSessionChild(session: SessionState): Promise<AcpChild> {
		const profile = this.profiles.get(session.profile);
		if (!profile) throw new Error(`profile ${session.profile} no longer exists`);
		let child = this.children.get(session.profile);
		if (!child?.alive) child = await this.ensureChild(profile);
		await child.initialize(this.clientInitialize);
		if (child.loadedSessions.has(session.childSessionId)) return child;

		const resumed = await child.request("session/resume", {
			sessionId: session.childSessionId,
			cwd: session.cwd,
			mcpServers: session.mcpServers,
			...(session.additionalDirectories ? { additionalDirectories: session.additionalDirectories } : {}),
		});
		if (!resumed.error) {
			child.loadedSessions.add(session.childSessionId);
			this.sessionsByChild.set(this.childKey(profile.slug, session.childSessionId), session);
			return child;
		}

		// The new process lost the conversation; create a fresh one and hand off.
		const created = await child.request("session/new", {
			cwd: session.cwd,
			mcpServers: session.mcpServers,
			...(session.additionalDirectories ? { additionalDirectories: session.additionalDirectories } : {}),
		});
		if (created.error) throw new AcpRpcError(created.error);
		const createdResult = isRecord(created.result) ? created.result : {};
		const createdId = readString(createdResult.sessionId);
		if (!createdId) throw new Error("agent returned no sessionId for session/new");
		const previousId = session.childSessionId;
		this.sessionsByChild.delete(this.childKey(profile.slug, previousId));
		session.childSessionId = createdId;
		session.record.childSessionId = createdId;
		session.record.updatedAt = new Date().toISOString();
		child.loadedSessions.add(createdId);
		this.sessionsByChild.set(this.childKey(profile.slug, createdId), session);
		session.needsHandoff = true;
		session.handoffSessionReady = true;
		this.log(`agent lost session ${previousId} on ${profile.slug}; created ${createdId}`);
		await this.saveStore();
		return child;
	}

	// ---------------------------------------------------------------------
	// Profile selection and usage
	// ---------------------------------------------------------------------

	private async rankCandidates(
		options: { modelId?: string; exclude?: string[]; allowBlocked?: boolean; prefer?: string[] } = {},
	): Promise<Profile[]> {
		const candidates = [...this.profiles.values()].filter(profile => !options.exclude?.includes(profile.slug));
		const usage = new Map<string, UsageSnapshot | null>();
		const models = new Map<string, ModelsSnapshot | null>();
		await Promise.all(
			candidates.map(async profile => {
				const [u, m] = await Promise.all([this.getUsage(profile), this.getModels(profile)]);
				usage.set(profile.slug, u);
				models.set(profile.slug, m);
			}),
		);
		const slugs = rankProfiles(candidates, usage, this.state, {
			modelId: options.modelId,
			now: Date.now(),
			reservePct: this.reservePct,
			...(options.modelId ? { models } : {}),
		});
		const bySlug = new Map(candidates.map(profile => [profile.slug, profile]));
		let ranked = slugs.map(slug => bySlug.get(slug)).filter((profile): profile is Profile => Boolean(profile));

		if (!ranked.length && options.allowBlocked) {
			ranked = candidates
				.filter(
					profile =>
						!profile.bannedAt &&
						!profile.authRequiredAt &&
						!profile.disabled &&
						!isModelKnownUnsupported(models.get(profile.slug), options.modelId),
				)
				.sort(
					(a, b) =>
						(this.blockReset(a.slug, options.modelId) ?? Number.POSITIVE_INFINITY) -
						(this.blockReset(b.slug, options.modelId) ?? Number.POSITIVE_INFINITY),
				);
		}
		if (options.prefer?.length) {
			const preferred = options.prefer;
			ranked = [
				...ranked.filter(profile => preferred.includes(profile.slug)),
				...ranked.filter(profile => !preferred.includes(profile.slug)),
			];
		}
		return ranked;
	}

	private blockReset(slug: string, modelId?: string): number | undefined {
		const family = familyForModel(modelId);
		const direct = this.state.blocks[slug]?.[family];
		if (direct !== undefined) return direct;
		return family === "gemini" ? this.state.blocks[slug]?.["claude-gpt"] : this.state.blocks[slug]?.gemini;
	}

	private refreshUsageInBackground(profile: Profile): void {
		if (profile.authRequiredAt || profile.bannedAt || profile.disabled) return;
		if (this.usageInflight.has(profile.slug)) return;
		const promise = fetchUsage(profile, undefined, this.usageAbort.signal)
			.catch(() => null)
			.then(snapshot => {
				if (snapshot) {
					this.usageCache.set(profile.slug, { snapshot, at: snapshot.fetchedAt });
				}
				this.usageInflight.delete(profile.slug);
				return snapshot;
			});
		this.usageInflight.set(profile.slug, promise);
	}

	private async getUsage(profile: Profile, force = false): Promise<UsageSnapshot | null> {
		const now = Date.now();
		const cached = this.usageCache.get(profile.slug);
		if (!force && cached && now - cached.at < USAGE_TTL_MS) return cached.snapshot;

		if (!force) {
			const diskCached = await readCachedUsage(profile.slug);
			if (diskCached) {
				this.usageCache.set(profile.slug, { snapshot: diskCached, at: diskCached.fetchedAt });
				if (now - diskCached.fetchedAt < USAGE_TTL_MS) {
					return diskCached;
				}
				this.refreshUsageInBackground(profile);
				return diskCached;
			}
			this.refreshUsageInBackground(profile);
			return null;
		}

		const inflight = this.usageInflight.get(profile.slug);
		if (inflight && !force) return inflight;
		const promise = fetchUsage(profile, undefined, this.usageAbort.signal)
			.catch(() => null)
			.then(snapshot => {
				if (snapshot) {
					this.usageCache.set(profile.slug, { snapshot, at: snapshot.fetchedAt });
				}
				this.usageInflight.delete(profile.slug);
				return snapshot;
			});
		this.usageInflight.set(profile.slug, promise);
		return promise;
	}

	private refreshModelsInBackground(profile: Profile): void {
		if (profile.authRequiredAt || profile.bannedAt || profile.disabled) return;
		if (this.modelsInflight.has(profile.slug)) return;
		const promise = fetchModels(profile, undefined, this.usageAbort.signal)
			.catch(() => null)
			.then(snapshot => {
				if (snapshot) {
					this.modelsCache.set(profile.slug, { snapshot, at: snapshot.fetchedAt });
				}
				this.modelsInflight.delete(profile.slug);
				return snapshot;
			});
		this.modelsInflight.set(profile.slug, promise);
	}

	private async getModels(profile: Profile): Promise<ModelsSnapshot | null> {
		const now = Date.now();
		const cached = this.modelsCache.get(profile.slug);
		if (cached && now - cached.at < MODELS_TTL_MS) return cached.snapshot;

		const diskCached = await readCachedModels(profile.slug);
		if (diskCached) {
			this.modelsCache.set(profile.slug, { snapshot: diskCached, at: diskCached.fetchedAt });
			if (now - diskCached.fetchedAt < MODELS_TTL_MS) {
				return diskCached;
			}
			this.refreshModelsInBackground(profile);
			return diskCached;
		}
		this.refreshModelsInBackground(profile);
		return null;
	}

	private recordDiscoveredModels(profile: Profile, result: Record<string, unknown>): void {
		const { models, configOptions } = extractAcpModelsFromResult(result);
		if (models.length === 0) return;
		const snapshot: ModelsSnapshot = {
			profile: profile.slug,
			fetchedAt: Date.now(),
			models,
			configOptions: configOptions.length > 0 ? configOptions : deriveBaseConfigOptions(models),
		};
		this.modelsCache.set(profile.slug, { snapshot, at: snapshot.fetchedAt });
		void writeCachedModels(snapshot).catch(() => {});
	}

	private async markModelUnsupported(profile: Profile, modelId: string): Promise<void> {
		const existing = this.modelsCache.get(profile.slug)?.snapshot ?? (await readCachedModels(profile.slug));
		const updated = withoutUnsupportedModel(existing, modelId);
		if (updated) {
			this.modelsCache.set(profile.slug, { snapshot: updated, at: updated.fetchedAt });
			await writeCachedModels(updated).catch(() => {});
		}
		this.refreshModelsInBackground(profile);
	}

	private mergeSessionModelsResult(result: Record<string, unknown>): Record<string, unknown> {
		const healthySnapshots = [...this.profiles.values()]
			.filter(p => !p.bannedAt && !p.authRequiredAt && !p.disabled)
			.map(p => this.modelsCache.get(p.slug)?.snapshot)
			.filter((s): s is ModelsSnapshot => Boolean(s && s.models.length > 0));
		if (healthySnapshots.length === 0) return result;

		const extracted = extractAcpModelsFromResult(result);
		const mergedAvailable = mergeModelLists([
			...healthySnapshots.map(s => s.models),
			extracted.models,
		]);
		const mergedConfigChoices = mergeConfigOptionLists([
			...healthySnapshots.map(s => s.configOptions ?? deriveBaseConfigOptions(s.models)),
			extracted.configOptions,
		]);

		let nextResult: Record<string, unknown> = result;
		if (mergedAvailable.length > 0 && isRecord(result.models)) {
			nextResult = {
				...nextResult,
				models: { ...result.models, availableModels: mergedAvailable },
			};
		}
		if (mergedConfigChoices.length > 0 && Array.isArray(result.configOptions)) {
			nextResult = {
				...nextResult,
				configOptions: result.configOptions.map(opt =>
					isRecord(opt) && opt.id === "model" ? { ...opt, options: mergedConfigChoices } : opt,
				),
			};
		}
		return nextResult;
	}

	private async isLowQuota(profile: Profile, family: Family): Promise<boolean> {
		const snapshot = await this.getUsage(profile);
		const remaining = minRemaining(snapshot, family);
		return remaining !== undefined && remaining <= this.reservePct;
	}

	private async recordFailure(profile: Profile, session: SessionState | undefined, kind: FailureKind): Promise<void> {
		if (kind === "banned") {
			profile.bannedAt = new Date().toISOString();
			profile.bannedReason = "violation of Terms of Service";
			await saveProfile(profile);
			return;
		}
		if (kind === "auth") {
			profile.authRequiredAt = new Date().toISOString();
			await saveProfile(profile);
			return;
		}
		if (kind !== "quota") return;
		const family = familyForModel(session?.modelId);
		const snapshot = await this.getUsage(profile, true);
		const until = blockingReset(snapshot, family, Date.now()) ?? Date.now() + DEFAULT_BLOCK_MS;
		block(this.state, profile.slug, family, until);
		await saveState(this.state);
		this.log(`blocked ${profile.slug}:${family} until ${new Date(until).toISOString()}`);
	}

	// ---------------------------------------------------------------------
	// Handshake and session lifecycle
	// ---------------------------------------------------------------------

	private async onInitialize(request: JsonRpcRequest): Promise<void> {
		this.clientInitialize = request.params;
		const candidates = this.getHealthyProfiles();
		if (!candidates.length) throw new Error("no profiles configured; add one with `agy-multi profile add <slug>`");
		let lastError: unknown;
		for (const profile of candidates.slice(0, Math.min(candidates.length, 3))) {
			try {
				const child = await this.ensureChild(profile);
				const result = await child.initialize(request.params);
				this.controlChild = child;
				this.respond(request.id, result);
				return;
			} catch (error) {
				lastError = error;
				this.children.get(profile.slug)?.kill();
				this.children.delete(profile.slug);
				this.log(`initialize failed on ${profile.slug}: ${errorMessage(error)}`);
			}
		}
		throw lastError ?? new Error("initialize failed on every profile");
	}

	private async onAuthenticate(request: JsonRpcRequest): Promise<void> {
		const params = isRecord(request.params) ? request.params : {};
		const child = this.controlChild?.alive ? this.controlChild : await this.ensureControlChild();
		const response = await child.request("authenticate", params);
		if (response.error) throw new AcpRpcError(response.error);
		const profile = this.profiles.get(child.slug);
		if (profile?.authRequiredAt) {
			delete profile.authRequiredAt;
			await saveProfile(profile);
		}
		this.respond(request.id, response.result ?? {});
	}

	private async onSessionNew(request: JsonRpcRequest): Promise<void> {
		const params = isRecord(request.params) ? request.params : {};
		const cwd = readString(params.cwd);
		if (!cwd) throw new Error("session/new requires an absolute cwd");
		const mcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : [];
		const additionalDirectories = readStringArray(params.additionalDirectories);
		const payload: Record<string, unknown> = { ...params, cwd, mcpServers };
		if (additionalDirectories) payload.additionalDirectories = additionalDirectories;
		else delete payload.additionalDirectories;

		const candidates = await this.rankCandidates({ allowBlocked: true });
		if (!candidates.length) throw new Error("no profiles configured");
		let lastError: unknown;
		for (const profile of candidates.slice(0, Math.min(candidates.length, 3))) {
			try {
				const child = await this.ensureChild(profile);
				await child.initialize(this.clientInitialize);
				const response = await child.request("session/new", payload);
				if (response.error) throw new AcpRpcError(response.error);
				const result = isRecord(response.result) ? response.result : {};
				const childSessionId = readString(result.sessionId);
				if (!childSessionId) throw new Error("agent returned no sessionId for session/new");

				this.recordDiscoveredModels(profile, result);
				const proxySessionId = randomUUID();
				const now = new Date().toISOString();
				const record: AcpSessionRecord = {
					id: proxySessionId,
					profile: profile.slug,
					childSessionId,
					cwd,
					...(additionalDirectories ? { additionalDirectories } : {}),
					mcpServers,
					createdAt: now,
					updatedAt: now,
				};
				const session: SessionState = { ...record, mcpServers, history: [], record, pendingOut: [] };
				const models = isRecord(result.models) ? result.models : undefined;
				if (models && typeof models.currentModelId === "string") session.modelId = models.currentModelId;
				child.loadedSessions.add(childSessionId);
				this.sessions.set(proxySessionId, session);
				this.store.sessions[proxySessionId] = record;
				await this.saveStore();

				const key = this.childKey(profile.slug, childSessionId);
				this.sessionsByChild.set(key, session);
				const buffered = this.unknownUpdates.get(key);
				if (buffered) {
					this.unknownUpdates.delete(key);
					for (const message of buffered) this.handleAgentNotification(child, message);
				}
				this.respond(request.id, { ...this.mergeSessionModelsResult(result), sessionId: proxySessionId });
				this.drainPendingOut(session);
				this.broadcastAvailableCommands(session);
				return;
			} catch (error) {
				lastError = error;
				const raw = error instanceof AcpRpcError ? error.rpcError : error;
				await this.recordFailure(profile, undefined, classifyAcpError(raw));
				this.log(`session/new failed on ${profile.slug}: ${errorMessage(error)}`);
			}
		}
		throw lastError ?? new Error("session/new failed on every profile");
	}

	private async onSessionLoad(request: JsonRpcRequest, resume: boolean): Promise<void> {
		const params = isRecord(request.params) ? request.params : {};
		const requestedId = readString(params.sessionId);
		if (!requestedId) throw new Error(`${resume ? "session/resume" : "session/load"} requires sessionId`);
		const mcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : undefined;
		const additionalDirectories = readStringArray(params.additionalDirectories);

		let session = this.sessions.get(requestedId);
		if (!session) {
			let record = this.store.sessions[requestedId];
			if (!record) {
				// Re-read latest store from disk in case another process created it
				this.store = await loadAcpSessions(this.sessionsPath);
				record = this.store.sessions[requestedId];
			}
			if (record) {
				session = { ...record, mcpServers: record.mcpServers ?? [], history: [...(record.history ?? [])], record };
				this.sessions.set(record.id, session);
				this.sessionsByChild.set(this.childKey(record.profile, record.childSessionId), session);
			}
		}

		if (!session) {
			const owningProfile = await this.findProfileForSessionDb(requestedId);
			const candidates = await this.rankCandidates({ allowBlocked: true });
			const profile = owningProfile ?? candidates[0];
			if (!profile) throw new Error("no profiles configured");
			const cwd = readString(params.cwd);
			if (!cwd) throw new Error(`${resume ? "session/resume" : "session/load"} requires cwd for an unknown session`);
			const child = await this.ensureChild(profile);
			await child.initialize(this.clientInitialize);

			const now = new Date().toISOString();
			const createdRecord: AcpSessionRecord = {
				id: requestedId,
				profile: profile.slug,
				childSessionId: requestedId,
				cwd,
				...(additionalDirectories ? { additionalDirectories } : {}),
				mcpServers: mcpServers ?? [],
				createdAt: now,
				updatedAt: now,
			};
			const createdSession: SessionState = {
				...createdRecord,
				mcpServers: createdRecord.mcpServers ?? [],
				history: [],
				record: createdRecord,
			};
			this.sessions.set(requestedId, createdSession);
			this.sessionsByChild.set(this.childKey(profile.slug, requestedId), createdSession);
			this.store.sessions[requestedId] = createdRecord;
			createdSession.loading = !resume;

			const payload: Record<string, unknown> = { sessionId: requestedId, cwd, mcpServers: mcpServers ?? [] };
			if (additionalDirectories) payload.additionalDirectories = additionalDirectories;
			const response = await child.request(resume ? "session/resume" : "session/load", payload);
			createdSession.loading = false;
			if (response.error) {
				if (isSessionLostError(response.error)) {
					this.log(`child has no session ${requestedId} on ${profile.slug}; preparing fresh handoff`);
					createdSession.needsHandoff = true;
					createdSession.handoffSessionReady = false;
					this.respond(request.id, { sessionId: requestedId });
					this.broadcastAvailableCommands(createdSession);
					await this.saveStore();
					return;
				}
				createdSession.loadBuffers = undefined;
				this.sessions.delete(requestedId);
				this.sessionsByChild.delete(this.childKey(profile.slug, requestedId));
				delete this.store.sessions[requestedId];
				throw new AcpRpcError(response.error);
			}
			const result = isRecord(response.result) ? response.result : {};
			const models = isRecord(result.models) ? result.models : undefined;
			if (models && typeof models.currentModelId === "string") createdSession.modelId = models.currentModelId;
			child.loadedSessions.add(requestedId);
			this.flushLoadBuffers(createdSession);
			await this.saveStore();
			this.respond(
				request.id,
				typeof result.sessionId === "string" ? { ...result, sessionId: requestedId } : result,
			);
			this.broadcastAvailableCommands(createdSession);
			this.broadcastUsageUpdate(createdSession, profile);
			return;
		}

		const profile = this.profiles.get(session.profile);
		if (!profile) throw new Error(`profile ${session.profile} no longer exists`);
		const child = await this.ensureChild(profile);
		await child.initialize(this.clientInitialize);
		const cwd = readString(params.cwd) ?? session.cwd;
		const payload: Record<string, unknown> = {
			sessionId: session.childSessionId,
			cwd,
			mcpServers: mcpServers ?? session.mcpServers,
		};
		if (additionalDirectories) payload.additionalDirectories = additionalDirectories;

		// Old stores contain mappings only; hydrate once without replaying into
		// a client that requested resume (which must not duplicate its messages).
		const hydrate = resume && session.record.history === undefined;
		session.loading = !resume || hydrate;
		session.suppressReplay = hydrate;
		let response: JsonRpcResponse;
		try {
			response = await child.request(resume && !hydrate ? "session/resume" : "session/load", payload);
		} finally {
			session.loading = false;
			session.suppressReplay = false;
		}
		if (response.error) {
			session.loadBuffers = undefined;
			if (isSessionLostError(response.error)) {
				this.log(`child lost session ${session.childSessionId} on ${session.profile} during load/resume; preparing handoff`);
				session.needsHandoff = true;
				session.handoffSessionReady = false;
				this.respond(
					request.id,
					typeof response.result === "object" && response.result ? response.result : { sessionId: requestedId },
				);
				this.broadcastAvailableCommands(session);
				return;
			}
			throw new AcpRpcError(response.error);
		}
		child.loadedSessions.add(session.childSessionId);
		this.flushLoadBuffers(session);
		session.cwd = cwd;
		if (mcpServers) {
			session.mcpServers = mcpServers;
			session.record.mcpServers = mcpServers;
		}
		if (additionalDirectories) {
			session.additionalDirectories = additionalDirectories;
			session.record.additionalDirectories = additionalDirectories;
		}
		const result = isRecord(response.result) ? response.result : {};
		this.recordDiscoveredModels(profile, result);
		const models = isRecord(result.models) ? result.models : undefined;
		if (models && typeof models.currentModelId === "string") session.modelId = models.currentModelId;
		session.record.cwd = cwd;
		session.record.updatedAt = new Date().toISOString();
		await this.saveStore();
		this.respond(
			request.id,
			typeof result.sessionId === "string" ? { ...result, sessionId: requestedId } : result,
		);
		this.broadcastAvailableCommands(session);
		this.broadcastUsageUpdate(session, profile);
	}

	private onSessionList(request: JsonRpcRequest): void {
		const params = isRecord(request.params) ? request.params : {};
		const cwd = readString(params.cwd);
		const cursor = readString(params.cursor);
		const parsed = cursor ? Number.parseInt(cursor, 10) : 0;
		const start = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
		const limit = 100;
		const all = Object.values(this.store.sessions)
			.filter(record => !cwd || record.cwd === cwd)
			.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
		const page = all.slice(start, start + limit);
		this.respond(request.id, {
			sessions: page.map(record => ({
				sessionId: record.id,
				cwd: record.cwd,
				...(record.additionalDirectories ? { additionalDirectories: record.additionalDirectories } : {}),
				title: record.title ?? null,
				updatedAt: record.updatedAt ?? null,
			})),
			nextCursor: start + limit < all.length ? String(start + limit) : null,
		});
	}

	private async onSessionClose(request: JsonRpcRequest, remove: boolean): Promise<void> {
		const params = isRecord(request.params) ? request.params : {};
		const sessionId = readString(params.sessionId);
		if (!sessionId) throw new Error(`${remove ? "session/delete" : "session/close"} requires sessionId`);
		const session = this.sessions.get(sessionId);
		const record = session?.record ?? this.store.sessions[sessionId];
		if (!record) throw new Error(`unknown session: ${sessionId}`);
		const child = session ? this.children.get(session.profile) : undefined;
		if (child?.alive && child.loadedSessions.has(record.childSessionId)) {
			const response = await child.request(remove ? "session/delete" : "session/close", {
				sessionId: record.childSessionId,
			});
			// `agy` does not advertise session/delete; local bookkeeping is authoritative.
			if (response.error && !(remove && response.error.code === -32601)) {
				throw new AcpRpcError(response.error);
			}
			child.loadedSessions.delete(record.childSessionId);
		}
		if (remove) {
			this.deletedSessionIds.add(record.id);
			delete this.store.sessions[record.id];
			this.sessions.delete(record.id);
			this.sessionsByChild.delete(this.childKey(record.profile, record.childSessionId));
		} else {
			record.closedAt = new Date().toISOString();
			record.updatedAt = record.closedAt;
			if (session) session.closed = true;
		}
		await this.saveStore();
		this.respond(request.id, {});
	}

	private async onSessionFork(request: JsonRpcRequest): Promise<void> {
		const params = isRecord(request.params) ? request.params : {};
		const sessionId = readString(params.sessionId);
		if (!sessionId) throw new Error("session/fork requires sessionId");
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error(`unknown session: ${sessionId}`);
		const child = await this.ensureSessionChild(session);
		const response = await child.request("session/fork", { ...params, sessionId: session.childSessionId });
		if (response.error) throw new AcpRpcError(response.error);
		const result = isRecord(response.result) ? response.result : {};
		const forkProfile = this.profiles.get(session.profile);
		if (forkProfile) this.recordDiscoveredModels(forkProfile, result);
		const childSessionId = readString(result.sessionId);
		if (!childSessionId) throw new Error("agent returned no sessionId for session/fork");

		const now = new Date().toISOString();
		const id = randomUUID();
		const record: AcpSessionRecord = {
			id,
			profile: session.profile,
			childSessionId,
			cwd: session.cwd,
			...(session.additionalDirectories ? { additionalDirectories: session.additionalDirectories } : {}),
			mcpServers: session.mcpServers,
			createdAt: now,
			updatedAt: now,
		};
		const forked: SessionState = { ...record, mcpServers: record.mcpServers ?? [], history: [...session.history], modelId: session.modelId, record };
		const models = isRecord(result.models) ? result.models : undefined;
		if (models && typeof models.currentModelId === "string") forked.modelId = models.currentModelId;
		child.loadedSessions.add(childSessionId);
		this.sessions.set(id, forked);
		this.sessionsByChild.set(this.childKey(session.profile, childSessionId), forked);
		this.store.sessions[id] = record;
		await this.saveStore();
		this.respond(request.id, { ...result, sessionId: id });
	}

	private async onGenericRequest(request: JsonRpcRequest): Promise<void> {
		const params = isRecord(request.params) ? request.params : {};
		const sessionId = readString(params.sessionId);
		const session = sessionId ? this.sessions.get(sessionId) : undefined;
		if (session && request.method === "session/set_model") {
			const modelId = readString(params.modelId);
			if (modelId) {
				await this.handleModelChangeRequest(request, session, modelId, params);
				return;
			}
		}
		if (session && request.method === "session/set_config_option") {
			const configId = readString(params.configId);
			const value = params.value;
			if (configId === "model" && typeof value === "string") {
				await this.handleModelChangeRequest(request, session, value, params);
				return;
			}
		}

		const child = session ? await this.ensureSessionChild(session) : await this.ensureControlChild();
		const payload = session ? { ...params, sessionId: session.childSessionId } : params;
		const response = await child.request(request.method, payload);
		if (response.error) throw new AcpRpcError(response.error);
		this.respond(request.id, response.result ?? {});
	}

	private async handleModelChangeRequest(
		request: JsonRpcRequest,
		session: SessionState,
		modelId: string,
		params: Record<string, unknown>,
	): Promise<void> {
		session.modelId = modelId;
		session.record.updatedAt = new Date().toISOString();
		const currentProfile = this.profiles.get(session.profile);
		const family = familyForModel(modelId);

		let unsupportedOnCurrent = false;
		let lastUnsupportedError: AcpRpcError | undefined;
		if (currentProfile) {
			const currentModels = await this.getModels(currentProfile);
			unsupportedOnCurrent = isModelKnownUnsupported(currentModels, modelId);
		}

		if (currentProfile && !unsupportedOnCurrent) {
			const child = await this.ensureSessionChild(session);
			const response = await child.request(request.method, { ...params, sessionId: session.childSessionId });
			if (!response.error) {
				if (
					isBlocked(this.state, currentProfile.slug, family, Date.now()) ||
					(await this.isLowQuota(currentProfile, family))
				) {
					session.needsHandoff = true;
					session.handoffSessionReady = false;
				}
				await this.saveStore();
				this.respond(request.id, response.result ?? {});
				return;
			}
			if (!isModelUnsupportedError(response.error)) {
				throw new AcpRpcError(response.error);
			}
			unsupportedOnCurrent = true;
			lastUnsupportedError = new AcpRpcError(response.error);
			await this.markModelUnsupported(currentProfile, modelId);
		}

		const exclude = currentProfile ? [currentProfile.slug] : undefined;
		const candidates = await this.rankCandidates({ modelId, exclude, allowBlocked: false });

		if (session.history.length === 0) {
			for (const candidate of candidates.slice(0, Math.min(candidates.length, 3))) {
				try {
					const nextChild = await this.ensureChild(candidate);
					await nextChild.initialize(this.clientInitialize);
					const created = await nextChild.request("session/new", {
						cwd: session.cwd,
						mcpServers: session.mcpServers,
						...(session.additionalDirectories ? { additionalDirectories: session.additionalDirectories } : {}),
					});
					if (created.error) throw new AcpRpcError(created.error);
					const createdResult = isRecord(created.result) ? created.result : {};
					const createdId = readString(createdResult.sessionId);
					if (!createdId) throw new Error("agent returned no sessionId for session/new");
					this.recordDiscoveredModels(candidate, createdResult);

					const apply = await nextChild.request(request.method, { ...params, sessionId: createdId });
					if (apply.error) {
						nextChild.loadedSessions.delete(createdId);
						void nextChild.request("session/close", { sessionId: createdId }).catch(() => {});
						if (isModelUnsupportedError(apply.error)) {
							lastUnsupportedError = new AcpRpcError(apply.error);
							await this.markModelUnsupported(candidate, modelId);
							continue;
						}
						throw new AcpRpcError(apply.error);
					}

					const previousProfile = session.profile;
					const previousId = session.childSessionId;
					this.sessionsByChild.delete(this.childKey(previousProfile, previousId));
					session.childSessionId = createdId;
					session.profile = candidate.slug;
					session.record.childSessionId = createdId;
					session.record.profile = candidate.slug;
					session.needsHandoff = false;
					session.handoffSessionReady = false;
					nextChild.loadedSessions.add(createdId);
					this.sessionsByChild.set(this.childKey(candidate.slug, createdId), session);

					const oldChild = this.children.get(previousProfile);
					if (oldChild?.alive) {
						oldChild.loadedSessions.delete(previousId);
						void oldChild.request("session/close", { sessionId: previousId }).catch(() => {});
					}
					this.log(`switched session ${session.id} to ${candidate.slug} for model ${modelId}`);
					await this.saveStore();
					this.respond(request.id, apply.result ?? {});
					return;
				} catch (error) {
					if (error instanceof AcpRpcError && !isModelUnsupportedError(error.rpcError)) {
						throw error;
					}
					lastUnsupportedError = error instanceof AcpRpcError ? error : lastUnsupportedError;
				}
			}
			if (lastUnsupportedError) throw lastUnsupportedError;
			throw new Error(`no available account supports model ${modelId}`);
		}

		if (candidates.length > 0) {
			session.needsHandoff = true;
			session.handoffSessionReady = false;
			await this.saveStore();
			this.log(`deferred model switch for ${session.id} (${modelId}) to next handoff`);
			this.respond(request.id, {});
			return;
		}
		if (lastUnsupportedError) throw lastUnsupportedError;
		throw new Error(`no available account supports model ${modelId}`);
	}

	// ---------------------------------------------------------------------
	// Prompt execution and failover
	// ---------------------------------------------------------------------

	private onSessionPrompt(request: JsonRpcRequest): void {
		void this.runSessionPrompt(request).catch(error => {
			this.respondFailure(request.id, error);
		});
	}

	private async runSessionPrompt(request: JsonRpcRequest): Promise<void> {
		const params = isRecord(request.params) ? request.params : {};
		const sessionId = readString(params.sessionId);
		const session = sessionId ? this.sessions.get(sessionId) : undefined;
		if (!session) {
			this.respondError(request.id, -32602, `unknown session: ${sessionId ?? "(missing)"}`);
			return;
		}
		if (session.activeTurn) {
			this.respondError(request.id, -32603, "a prompt is already active for this session");
			return;
		}
		const userText = promptToText(params.prompt);
		if (!userText.trim()) {
			this.respondError(request.id, -32602, "empty prompt");
			return;
		}

		session.history.push({ role: "user", text: userText });
		const family = familyForModel(session.modelId);
		const current = this.profiles.get(session.profile);
		let target = current;
		let handoff = Boolean(session.needsHandoff);

		if (!current) {
			const candidates = await this.rankCandidates({ modelId: session.modelId, allowBlocked: false });
			const next = candidates[0];
			if (!next) {
				session.history.pop();
				this.respondError(request.id, -32000, "no available accounts");
				return;
			}
			target = next;
			handoff = true;
		} else {
			const blocked = isBlocked(this.state, current.slug, family, Date.now());
			const low = await this.isLowQuota(current, family);
			const unsupported = isModelKnownUnsupported(await this.getModels(current), session.modelId);
			const unhealthy = Boolean(current.bannedAt || current.authRequiredAt) || blocked || unsupported;
			if (unhealthy || low) {
				const candidates = await this.rankCandidates({
					modelId: session.modelId,
					exclude: [current.slug],
					allowBlocked: false,
				});
				const next = candidates[0];
				if (next) {
					target = next;
					handoff = true;
				} else if (unhealthy) {
					const until = current.bannedAt ? undefined : this.state.blocks[current.slug]?.[family];
					session.history.pop();
					this.respondError(
						request.id,
						-32000,
						current.bannedAt
							? "all accounts are banned or unavailable"
							: unsupported
								? `no available account supports model ${session.modelId}`
								: `all accounts are quota-blocked${until ? ` until ${new Date(until).toISOString()}` : ""}`,
					);
					return;
				}
			}
		}

		if (!target) {
			session.history.pop();
			this.respondError(request.id, -32000, "no available accounts");
			return;
		}
		await this.runPrompt(request.id, session, userText, target, handoff, 0);
	}

	private async runPrompt(
		clientId: JsonRpcId,
		session: SessionState,
		originalText: string,
		profile: Profile,
		handoff: boolean,
		switches: number,
	): Promise<void> {
		let text = originalText;
		try {
			const child = handoff ? await this.ensureChild(profile) : await this.ensureSessionChild(session);
			await child.initialize(this.clientInitialize);
			handoff ||= Boolean(session.needsHandoff);

			if (handoff) {
				const ready =
					session.handoffSessionReady === true &&
					session.profile === profile.slug &&
					this.sessionsByChild.get(this.childKey(profile.slug, session.childSessionId)) === session &&
					child.loadedSessions.has(session.childSessionId);
				if (!ready) {
					const created = await child.request("session/new", {
						cwd: session.cwd,
						mcpServers: session.mcpServers,
						...(session.additionalDirectories
							? { additionalDirectories: session.additionalDirectories }
							: {}),
					});
					if (created.error) throw new AcpRpcError(created.error);
					const createdResult = isRecord(created.result) ? created.result : {};
					const createdId = readString(createdResult.sessionId);
					if (!createdId) throw new Error("agent returned no sessionId for handoff session/new");
					this.recordDiscoveredModels(profile, createdResult);

					const previousProfile = session.profile;
					const previousId = session.childSessionId;
					this.sessionsByChild.delete(this.childKey(previousProfile, previousId));
					session.childSessionId = createdId;
					session.profile = profile.slug;
					session.record.childSessionId = createdId;
					session.record.profile = profile.slug;
					session.record.updatedAt = new Date().toISOString();
					child.loadedSessions.add(createdId);
					this.sessionsByChild.set(this.childKey(profile.slug, createdId), session);
					session.handoffSessionReady = true;
					session.needsHandoff = true;

					const oldChild = this.children.get(previousProfile);
					if (oldChild?.alive) {
						oldChild.loadedSessions.delete(previousId);
						void oldChild.request("session/close", { sessionId: previousId }).catch(() => {});
					}

					const models = isRecord(createdResult.models) ? createdResult.models : undefined;
					if (!session.modelId && models && typeof models.currentModelId === "string") {
						session.modelId = models.currentModelId;
					}
					await this.saveStore();
				}
				if (session.modelId) {
					const setModel = await child.request("session/set_model", {
						sessionId: session.childSessionId,
						modelId: session.modelId,
					});
					if (setModel.error) {
						if (isModelUnsupportedError(setModel.error) && switches < this.maxSwitches) {
							await this.markModelUnsupported(profile, session.modelId);
							const candidates = await this.rankCandidates({
								modelId: session.modelId,
								exclude: [profile.slug],
								allowBlocked: false,
							});
							const next = candidates[0];
							if (next) {
								await this.runPrompt(clientId, session, originalText, next, true, switches + 1);
								return;
							}
						}
						throw new AcpRpcError(setModel.error);
					}
				}
				const gitHead = await this.gitHead(session.cwd);
				text = buildHandoffPrompt({ history: session.history, cwd: session.cwd, gitHead });
			}

			const turn: TurnState = {
				assistantText: "",
				toolTitles: [],
				forwardedOutput: false,
				suppressUserChunk: handoff,
				daemonTasks: new Map(),
			};
			session.cancelled = false;
			session.activeTurn = turn;
			await this.saveStore();
			this.log(`prompt on ${profile.slug}${handoff ? " (handoff)" : ""} session=${session.id}`);

			let response = await child.request("session/prompt", {
				sessionId: session.childSessionId,
				prompt: [{ type: "text", text }],
			});

			const holdStartedAt = Date.now();
			let continuations = 0;
			while (!response.error && !session.cancelled && turn.daemonTasks.size > 0) {
				const taskIds = [...turn.daemonTasks.keys()];
				if (
					continuations >= DAEMON_HOLD_MAX_CONTINUATIONS ||
					Date.now() - holdStartedAt >= DAEMON_HOLD_MAX_MS
				) {
					session.activeTurn = undefined;
					this.log(
						`daemon tasks still running after ${continuations} continuation(s): ${taskIds.join(", ")}`,
					);
					this.respondError(
						clientId,
						-32000,
						`turn ended with unconfirmed background tasks: ${taskIds.join(", ")}. ` +
							"The work may still be running; no verified result was produced.",
					);
					return;
				}

				const waitMs = nextWaitMs(
					[...turn.daemonTasks.values()].flatMap(task =>
						task.waitUntil === undefined ? [] : [task.waitUntil],
					),
					Date.now(),
				);
				this.log(
					`turn ended with ${taskIds.length} background task(s) still running (${taskIds.join(", ")}); holding ${waitMs}ms before resuming`,
				);
				await this.waitForDaemon(waitMs, session);
				if (session.cancelled) break;

				continuations += 1;
				turn.daemonTasks.clear();
				// The hold prompt is proxy-owned; the client must not see it as a user turn.
				turn.suppressUserChunk = true;
				response = await child.request("session/prompt", {
					sessionId: session.childSessionId,
					prompt: [{ type: "text", text: daemonHoldPrompt(taskIds) }],
				});
			}
			session.activeTurn = undefined;

			if (session.cancelled && !response.error) {
				this.log(`prompt cancelled on ${profile.slug} session=${session.id}`);
				this.respond(clientId, { stopReason: "cancelled" });
				return;
			}

			if (response.error) {
				const isLost = isSessionLostError(response.error);
				const isUnsupportedModel = Boolean(session.modelId) && isModelUnsupportedError(response.error);
				const kind = classifyAcpError(response.error);
				this.log(
					`prompt failed on ${profile.slug}: ${isLost ? "session_lost" : isUnsupportedModel ? "model_unsupported" : kind}: ${response.error.message}`,
				);
				if (!isLost && !isUnsupportedModel) {
					await this.recordFailure(profile, session, kind);
				}
				if (isUnsupportedModel && session.modelId) {
					await this.markModelUnsupported(profile, session.modelId);
				}
				const switchable = isLost || isUnsupportedModel || kind === "quota" || kind === "banned" || kind === "auth";
				if (switchable && !turn.forwardedOutput && switches < this.maxSwitches) {
					if (isLost) {
						this.log(`recovering lost trajectory ${session.childSessionId} on ${profile.slug} via handoff`);
						child.loadedSessions.delete(session.childSessionId);
						session.needsHandoff = true;
						session.handoffSessionReady = false;
						await this.runPrompt(clientId, session, originalText, profile, true, switches + 1);
						return;
					}
					const candidates = await this.rankCandidates({
						modelId: session.modelId,
						exclude: [profile.slug],
						allowBlocked: false,
					});
					const next = candidates[0];
					if (next) {
						await this.runPrompt(clientId, session, originalText, next, true, switches + 1);
						return;
					}
				}
				if (turn.forwardedOutput) {
					const parts: string[] = [];
					if (turn.assistantText.trim()) parts.push(turn.assistantText.trim());
					if (turn.toolTitles.length) parts.push(`[used tools: ${turn.toolTitles.join(", ")}]`);
					if (parts.length) {
						session.history.push({
							role: "assistant",
							text: `${parts.join("\n\n")}\n\n(interrupted: ${kind})`,
						});
					}
				}
				if (switchable) {
					session.needsHandoff = true;
					session.handoffSessionReady = false;
				}
				session.record.updatedAt = new Date().toISOString();
				await this.saveStore();
				this.respondError(clientId, response.error.code, response.error.message, response.error.data);
				return;
			}

			const result = isRecord(response.result) ? response.result : {};
			const stopReason = readString(result.stopReason) ?? "end_turn";
			if (turn.assistantText.trim()) {
				session.history.push({ role: "assistant", text: turn.assistantText.trim() });
			} else if (turn.toolTitles.length) {
				session.history.push({ role: "assistant", text: `[used tools: ${turn.toolTitles.join(", ")}]` });
			}
			session.needsHandoff = false;
			session.handoffSessionReady = false;
			session.record.updatedAt = new Date().toISOString();
			profile.lastGenerationOkAt = new Date().toISOString();
			if (profile.authRequiredAt) delete profile.authRequiredAt;
			await saveProfile(profile);
			await this.saveStore();

			const autoCompacted = await this.maybeAutoCompact(child, session, profile);

			if (!turn.seenUsageUpdate || autoCompacted) {
				this.broadcastUsageUpdate(session, profile);
			}

			this.respond(clientId, response.result ?? { stopReason });
		} catch (error) {
			session.activeTurn = undefined;
			this.respondFailure(clientId, error);
		}
	}

	/**
	 * Automatically triggers compaction via "/compact" if measured token usage
	 * reaches or exceeds the compaction threshold (default: 300,000 tokens).
	 * Maintenance output is suppressed so the client's conversation view is unaffected.
	 */
	private async maybeAutoCompact(
		child: AcpChild,
		session: SessionState,
		profile: Profile,
	): Promise<boolean> {
		if (this.compactionThreshold <= 0 || session.cancelled) return false;
		const profileHome = profileHomeOf(profile);
		const usage = resolveSessionTokenUsage(profileHome, session.childSessionId);
		if (!usage || usage.usedTokens < this.compactionThreshold) return false;

		this.log(
			`token usage (${usage.usedTokens}) reached threshold (${this.compactionThreshold}) on ${profile.slug} session=${session.id}; triggering auto-compaction`,
		);

		const compactionTurn: TurnState = {
			assistantText: "",
			toolTitles: [],
			forwardedOutput: false,
			suppressUserChunk: true,
			suppressOutput: true,
			daemonTasks: new Map(),
		};
		session.activeTurn = compactionTurn;

		try {
			const compactPromise = child.request("session/prompt", {
				sessionId: session.childSessionId,
				prompt: [{ type: "text", text: "/compact" }],
			});
			const timeoutPromise = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("auto-compaction timed out after 30s")), 30_000),
			);
			const compactResponse = await Promise.race([compactPromise, timeoutPromise]);
			if (compactResponse.error) {
				this.log(
					`auto-compaction prompt failed on ${profile.slug} session=${session.id}: ${compactResponse.error.message}`,
				);
				return false;
			} else {
				const afterUsage = resolveSessionTokenUsage(profileHome, session.childSessionId);
				this.log(
					`auto-compaction completed on ${profile.slug} session=${session.id}: ${usage.usedTokens} -> ${afterUsage?.usedTokens ?? "unknown"} tokens`,
				);
				return true;
			}
		} catch (error) {
			this.log(`auto-compaction error on ${profile.slug} session=${session.id}: ${errorMessage(error)}`);
			return false;
		} finally {
			if (session.activeTurn === compactionTurn) {
				session.activeTurn = undefined;
			}
		}
	}

	/** Waits for a daemon wake-up, staying responsive to `session/cancel`. */
	private async waitForDaemon(ms: number, session: SessionState): Promise<void> {
		const deadline = Date.now() + Math.max(0, ms);
		while (!session.cancelled && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
		}
	}

	private async gitHead(cwd: string): Promise<string | undefined> {		const result = await run(["git", "rev-parse", "HEAD"], { cwd }).catch(() => null);
		if (!result || result.exitCode !== 0) return undefined;
		return result.stdout.trim() || undefined;
	}

	// ---------------------------------------------------------------------
	// Load replay and session-store helpers
	// ---------------------------------------------------------------------

	private trackLoadChunk(session: SessionState, role: "user" | "assistant", text: string): void {
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

	private flushLoadBuffers(session: SessionState): void {
		if (!session.loadBuffers) return;
		const buffers = session.loadBuffers;
		if (buffers.user) buffers.history.push({ role: "user", text: buffers.user });
		if (buffers.assistant) buffers.history.push({ role: "assistant", text: buffers.assistant });
		// Child replay covers only the current account, not earlier handoffs.
		if (!session.history.length) session.history = buffers.history;
		session.loadBuffers = undefined;
	}

	private drainPendingOut(session: SessionState): void {
		const pending = session.pendingOut;
		session.pendingOut = undefined;
		if (pending) {
			for (const message of pending) this.sendToClient(message);
		}
	}

	private childKey(profile: string, childSessionId: string): string {
		return `${profile}\u0000${childSessionId}`;
	}

	private async findProfileForSessionDb(sessionId: string): Promise<Profile | undefined> {
		for (const profile of this.profiles.values()) {
			const dbPath = join(profileHome(profile.slug), ".gemini", "antigravity-cli", "conversations", `${sessionId}.db`);
			if (await exists(dbPath)) {
				return profile;
			}
		}
		return undefined;
	}

	private saveStore(): Promise<void> {
		for (const session of this.sessions.values()) {
			session.record.history = [...session.history];
			session.record.modelId = session.modelId;
			session.record.needsHandoff = session.needsHandoff;
			session.record.handoffSessionReady = session.handoffSessionReady;
		}
		const snapshot = structuredClone(this.store);
		const deleted = new Set(this.deletedSessionIds);
		const next = this.saveChain.then(() => saveAcpSessions(snapshot, this.sessionsPath, deleted));
		// The caller sees this write's failure; the queue remains usable.
		this.saveChain = next.catch(() => {});
		return next;
	}

}

export async function runAcpProxy(options: AcpProxyOptions = {}): Promise<void> {
	await syncProfiles();
	const proxy = new AcpProxy(options);
	await proxy.start();
}
