import { join } from "node:path";
import { AccountPool } from "../account-pool";
import { classifyAcpError, isModelUnsupportedError, isSessionLostError } from "../classify";
import { exists, isRecord } from "../fs-utils";
import { buildSkillsBlock, findSkill, listUserSkills } from "../injection";
import { isModelKnownUnsupported, ModelCatalog } from "../model-catalog";
import {
	ACP_SESSIONS_PATH,
	AGY_BIN,
	DEFAULT_RESERVE_PCT,
	DEFAULT_SWITCH_DELAY_MS,
	profileHome,
} from "../paths";
import { ProbeSync } from "../probe-sync";
import { syncProfiles } from "../profile";
import { profileHomeOf } from "../registry";
import type { FailureKind, Family, Profile, UsageSnapshot } from "../types";
import { familyForModel, formatMultiUsageReport, readCachedUsage } from "../usage";
import { AcpChild, AcpRpcError } from "./child";
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
import { buildHandoffPrompt, promptToText, SessionLedger, type SessionState } from "./session-ledger";
import { TurnSupervisor, type TurnTransport } from "./turn-supervisor";

/** `0` replays the whole conversation: a handoff must not rewrite what the user saw. */
const DEFAULT_HANDOFF_CONTEXT_CHARS = 0;

export interface AcpProxyOptions {
	agyBin?: string;
	extraArgs?: string[];
	clean?: boolean;
	skills?: string[];
	maxSwitches?: number;
	reservePct?: number;
	compactionThreshold?: number;
	sessionsPath?: string;
	log?: (line: string) => void;
	/** Pause before handing a turn to another account (default: 10s). */
	switchDelayMs?: number;
	/** Character budget for replaying the conversation into a fresh backend session (`0` = full). */
	handoffContextChars?: number;
	/** Keep exactly one account active at a time and skip idle-account background sync. */
	sequential?: boolean;
}

function hasCleanArg(args: string[]): boolean {
	return args.some(
		(arg, i) =>
			arg === "--include-default-customizations=false" ||
			(arg === "--include-default-customizations" && args[i + 1] === "false"),
	);
}

function readAntigravityMeta(params: Record<string, unknown>): {
	skills?: string[];
	systemPromptAppend?: string;
} {
	const meta = isRecord(params._meta) ? params._meta : undefined;
	const agy = meta && isRecord(meta.antigravity) ? meta.antigravity : undefined;
	if (!agy) return {};
	const skills = Array.isArray(agy.skills)
		? agy.skills
				.filter((item): item is string => typeof item === "string")
				.map(item => item.trim())
				.filter(Boolean)
		: undefined;
	const sys = isRecord(agy.systemPrompt) ? agy.systemPrompt : undefined;
	const systemPromptAppend = sys && typeof sys.append === "string" && sys.append ? sys.append : undefined;
	return { skills, systemPromptAppend };
}

function buildChildNewSessionPayload(options: {
	baseParams?: Record<string, unknown>;
	cwd: string;
	mcpServers: unknown[];
	additionalDirectories?: string[];
	skills?: string[];
	systemPromptAppend?: string;
}): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		...(options.baseParams ?? {}),
		cwd: options.cwd,
		mcpServers: options.mcpServers,
	};
	if (options.additionalDirectories) payload.additionalDirectories = options.additionalDirectories;
	else delete payload.additionalDirectories;

	const rawMeta = isRecord(payload._meta) ? { ...payload._meta } : undefined;
	const rawAgy = rawMeta && isRecord(rawMeta.antigravity) ? { ...rawMeta.antigravity } : undefined;
	if (rawAgy) delete rawAgy.skills;

	const skillsBlock =
		options.skills && options.skills.length > 0 ? buildSkillsBlock(options.skills, options.cwd) : "";
	const existingAppend =
		rawAgy && isRecord(rawAgy.systemPrompt) && typeof rawAgy.systemPrompt.append === "string"
			? rawAgy.systemPrompt.append
			: options.systemPromptAppend;
	const combinedAppend = [existingAppend, skillsBlock].filter(part => Boolean(part && part.trim())).join("\n\n");

	if (combinedAppend) {
		const nextAgy: Record<string, unknown> = {
			...(rawAgy ?? {}),
			systemPrompt: {
				...(rawAgy && isRecord(rawAgy.systemPrompt) ? rawAgy.systemPrompt : {}),
				append: combinedAppend,
			},
		};
		payload._meta = { ...(rawMeta ?? {}), antigravity: nextAgy };
	} else if (rawMeta && rawAgy) {
		if (Object.keys(rawAgy).length === 0) {
			delete rawMeta.antigravity;
		} else {
			rawMeta.antigravity = rawAgy;
		}
		if (Object.keys(rawMeta).length === 0) delete payload._meta;
		else payload._meta = rawMeta;
	}
	return payload;
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
 * Advertise `sessionCapabilities.fork = {}` since the proxy handles `session/fork`
 * natively when supported by the child or via `session/new` + transcript replay fallback.
 */
function augmentInitializeResult(result: unknown): unknown {
	if (!isRecord(result)) return result;
	const capabilities = isRecord(result.agentCapabilities) ? result.agentCapabilities : {};
	const hasCamel = isRecord(capabilities.sessionCapabilities);
	const hasSnake = isRecord(capabilities.session_capabilities);

	const nextCapabilities: Record<string, unknown> = { ...capabilities };
	if (hasCamel) {
		const existing = capabilities.sessionCapabilities as Record<string, unknown>;
		nextCapabilities.sessionCapabilities = {
			...existing,
			fork: isRecord(existing.fork) ? existing.fork : {},
		};
	}
	if (hasSnake) {
		const existing = capabilities.session_capabilities as Record<string, unknown>;
		nextCapabilities.session_capabilities = {
			...existing,
			fork: isRecord(existing.fork) ? existing.fork : {},
		};
	}
	if (!hasCamel && !hasSnake) {
		nextCapabilities.sessionCapabilities = { fork: {} };
	}

	return {
		...result,
		agentCapabilities: nextCapabilities,
	};
}

/**
 * Stdio JSON-RPC 2.0 ACP router fronting per-profile `agy acp` child processes.
 *
 * Delegates pool ranking/state to `AccountPool`, model/reasoning catalogs to `ModelCatalog`,
 * parallel probing to `ProbeSync`, session identity/persistence to `SessionLedger`, and
 * turn supervision (daemon holds, auto-compaction, usage updates) to `TurnSupervisor`.
 */
class AcpProxy {
	private readonly agyBin: string;
	private readonly extraArgs: string[];
	private readonly clean: boolean;
	private readonly defaultSkills?: string[];
	private readonly switchDelayMs: number;
	private readonly handoffContextChars: number;
	private readonly sequential: boolean;
	private readonly maxSwitches: number;
	private readonly reservePct: number;
	private readonly log: (line: string) => void;
	private readonly out: LineWriter;

	private readonly catalog = new ModelCatalog();
	private readonly ledger: SessionLedger;
	private readonly turns: TurnSupervisor;
	private readonly children = new Map<string, AcpChild>();
	private readonly agentRequests = new Map<string, { child: AcpChild; id: JsonRpcId }>();
	private readonly releaseCandidates = new Set<string>();
	private readonly probeAbort = new AbortController();

	private pool!: AccountPool;
	private probes!: ProbeSync;
	private clientInitialize?: unknown;
	private controlChild?: AcpChild;
	private agentRequestSeq = 0;
	private activeClientRequests = 0;
	private shuttingDown = false;

	constructor(options: AcpProxyOptions = {}) {
		this.agyBin = options.agyBin ?? AGY_BIN;
		this.extraArgs = options.extraArgs ?? [];
		this.clean = options.clean ?? hasCleanArg(this.extraArgs);
		this.defaultSkills = options.skills && options.skills.length > 0 ? [...options.skills] : undefined;
		this.switchDelayMs = options.switchDelayMs ?? DEFAULT_SWITCH_DELAY_MS;
		this.handoffContextChars = options.handoffContextChars ?? DEFAULT_HANDOFF_CONTEXT_CHARS;
		this.sequential = options.sequential ?? false;
		this.maxSwitches = options.maxSwitches ?? 3;
		this.reservePct = options.reservePct ?? DEFAULT_RESERVE_PCT;
		this.log = options.log ?? (line => process.stderr.write(`[agy-multi acp] ${line}\n`));
		this.out = new LineWriter({ write: line => process.stdout.write(line) });
		this.ledger = new SessionLedger(options.sessionsPath ?? ACP_SESSIONS_PATH);
		this.turns = new TurnSupervisor({
			compactionThreshold: options.compactionThreshold,
			log: this.log,
		});
	}

	async start(): Promise<void> {
		this.pool = await AccountPool.load({ reservePct: this.reservePct });
		await this.ledger.load();
		await this.catalog.warmFromDisk(this.pool.list());
		this.probes = new ProbeSync({
			signal: this.probeAbort.signal,
			onModels: snapshot => this.catalog.remember(snapshot),
			onAuthRequired: slug => {
				void this.pool.recordFailure(slug, "auth").catch(() => {});
			},
		});

		this.log(
			`ready — ${this.pool.size} profile(s), ${this.ledger.storedCount} stored session(s), ` +
				`mode: ${this.sequential ? "sequential" : "pool"}, ` +
				`auto-compaction: ${this.turns.compactionThreshold > 0 ? `${this.turns.compactionThreshold} tokens` : "disabled"}`,
		);

		// Bind stdio immediately so `initialize` has zero startup delay.
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

		// In default pool mode, warm stale usage/models/reasoning across all healthy accounts
		// in parallel in the background so catalogs and rankings stay fresh automatically.
		if (!this.sequential) {
			const healthy = this.pool.healthyProfiles();
			if (healthy.length > 0) {
				void this.probes
					.syncAll(healthy, { usage: true, models: true, reasoning: true })
					.catch(() => {});
			}
		}
	}

	private noUsableAccountError(): Error {
		return new Error("no profiles configured; add one with `agy-multi profile add`");
	}

	private async paceAccountSwitch(from: string, to: string): Promise<void> {
		if (from === to || this.switchDelayMs <= 0) return;
		this.log(`waiting ${this.switchDelayMs}ms before moving this turn from ${from} to ${to}`);
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, this.switchDelayMs);
		await promise;
	}

	private shutdown(): void {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		this.probeAbort.abort();
		for (const child of this.children.values()) child.kill();
		this.children.clear();
		process.exit(0);
	}

	private sendToClient(message: unknown): void {
		this.out.write(message);
	}

	private respond(id: JsonRpcId, result: unknown): void {
		this.sendToClient({ jsonrpc: "2.0", id, result: this.catalog.filterOutbound(result) });
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

	private transportFor(child: AcpChild): TurnTransport {
		return {
			request: (method, params) => child.request(method, params),
			emit: message => this.sendToClient(message),
		};
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
		this.activeClientRequests++;
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
					return await this.runSessionPrompt(request);
				default:
					return await this.onGenericRequest(request);
			}
		} catch (error) {
			this.respondFailure(request.id, error);
		} finally {
			this.activeClientRequests--;
			this.releaseClosedChildren();
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
		const sessionId = params ? readString(params.sessionId) : undefined;
		const session = sessionId ? this.ledger.get(sessionId) : undefined;

		if (notification.method === "session/cancel") {
			if (!session) return;
			session.cancelled = true;
			const child = this.children.get(session.profile);
			if (child?.alive) child.notify("session/cancel", { sessionId: session.childSessionId });
			return;
		}

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
		const session = this.ledger.getByChild(child.slug, childSessionId);
		if (!session) {
			this.ledger.bufferUnknownUpdate(child.slug, childSessionId, message);
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
		const targetProfile = this.pool.get(session.profile);
		const profileHomeDir = targetProfile ? profileHomeOf(targetProfile) : undefined;
		const handledByTurn = this.turns.handleTurnUpdate({
			session,
			kind,
			update,
			outMessage,
			deliver,
			profileHomeDir,
			emit: value => this.sendToClient(value),
			onLoadChunk: (role, text) => this.ledger.trackLoadChunk(session, role, text),
		});
		if (handledByTurn) return;

		if (kind === "session_info_update") {
			const title = readString(update.title);
			if (title) {
				session.record.title = title;
				session.record.updatedAt = new Date().toISOString();
				void this.ledger.save().catch(error => this.log(`failed to persist session title: ${errorMessage(error)}`));
			}
			deliver(outMessage);
			return;
		}
		if (kind === "available_commands_update") {
			const commands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
			const augmented = this.buildAvailableCommands(session.cwd, commands, session.skills);
			deliver({ ...outMessage, params: { ...outParams, update: { ...update, availableCommands: augmented } } });
			return;
		}
		if (kind === "config_option_update") {
			const enriched = this.catalog.enrichConfigOptionsUpdate(update, this.pool.healthyProfiles());
			deliver({ ...outMessage, params: { ...outParams, update: this.catalog.filterOutbound(enriched) } });
			return;
		}
		deliver(outMessage);
	}

	private handleAgentRequest(child: AcpChild, request: JsonRpcRequest): void {
		const params = isRecord(request.params) ? request.params : undefined;
		const childSessionId = params ? readString(params.sessionId) : undefined;
		const session = childSessionId ? this.ledger.getByChild(child.slug, childSessionId) : undefined;
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

	private buildAvailableCommands(
		cwd?: string,
		childCommands: unknown[] = [],
		sessionSkills?: string[],
	): Array<{ name: string; description?: string; input?: { hint?: string } }> {
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
			"multi-usage",
		]);

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
			{ name: "multi-usage", description: "Show average 5-hour and weekly quota limits across all accounts" },
		];

		for (const std of STANDARD_COMMANDS) add(std.name, std.description);
		const declaredSkills = sessionSkills ?? this.defaultSkills;
		if (declaredSkills && declaredSkills.length > 0) {
			for (const id of declaredSkills) {
				const resolved = findSkill(id, undefined, cwd);
				if (resolved) add(`$${resolved.name}`, resolved.description || undefined);
			}
		}
		if (!this.clean) {
			for (const skill of listUserSkills(cwd)) add(`$${skill.name}`, skill.description);
		}

		for (const cmd of childCommands) {
			if (isRecord(cmd) && typeof cmd.name === "string") {
				const name = cmd.name.trim();
				if (!name) continue;
				const desc = typeof cmd.description === "string" ? cmd.description : undefined;
				const hint = isRecord(cmd.input) && typeof cmd.input.hint === "string" ? cmd.input.hint : undefined;
				if (SYSTEM_SLASH_COMMANDS.has(name.toLowerCase())) {
					add(name, desc, hint);
				} else if (!this.clean) {
					add(name.startsWith("$") ? name : `$${name}`, desc, hint);
				}
			}
		}
		return result;
	}

	private broadcastAvailableCommands(session: SessionState): void {
		this.sendToClient({
			jsonrpc: "2.0",
			method: "session/update",
			params: {
				sessionId: session.id,
				update: {
					sessionUpdate: "available_commands_update",
					availableCommands: this.buildAvailableCommands(session.cwd, [], session.skills),
				},
			},
		});
	}

	private broadcastUsageUpdate(session: SessionState, profile?: Profile): void {
		const target = profile ?? this.pool.get(session.profile);
		if (!target) return;
		this.turns.broadcastUsageUpdate(session, profileHomeOf(target), msg => this.sendToClient(msg));
	}

	// ---------------------------------------------------------------------
	// Child lifecycle
	// ---------------------------------------------------------------------

	private releaseClosedChildren(): void {
		if (this.activeClientRequests > 0) return;
		for (const slug of this.releaseCandidates) {
			this.releaseCandidates.delete(slug);
			const child = this.children.get(slug);
			if (!child || child.loadedSessions.size > 0) continue;
			this.children.delete(slug);
			if (this.controlChild === child) this.controlChild = undefined;
			child.kill();
			this.log(`released agent ${slug} with no remaining sessions`);
		}
	}

	private closePreviousChildSession(previousProfile: string, previousChildId: string): void {
		const oldChild = this.children.get(previousProfile);
		if (!oldChild?.alive) return;
		oldChild.loadedSessions.delete(previousChildId);
		void oldChild.request("session/close", { sessionId: previousChildId }).catch(() => {});
		this.releaseCandidates.add(previousProfile);
	}

	private async stopOtherChildren(keepSlug: string): Promise<void> {
		const others = [...this.children.entries()].filter(([slug]) => slug !== keepSlug);
		for (const [slug, child] of others) {
			this.children.delete(slug);
			if (this.controlChild === child) this.controlChild = undefined;
			child.loadedSessions.clear();
			this.refreshServedAccount(slug);
			await child.stop();
			this.log(`stopped agent ${slug}: sequential mode keeps one account active`);
		}
	}

	private async ensureChild(profile: Profile): Promise<AcpChild> {
		const existing = this.children.get(profile.slug);
		if (existing?.alive) return existing;
		existing?.kill();
		if (this.sequential) {
			const busy = this.ledger.profileWithActiveTurn(profile.slug);
			if (busy) {
				throw new Error(
					`sequential mode: account ${busy} is mid-turn; refusing to activate ${profile.slug} until that turn ends`,
				);
			}
			await this.stopOtherChildren(profile.slug);
		}
		const child = new AcpChild({
			profile,
			agyBin: this.agyBin,
			extraArgs: this.extraArgs,
			clean: this.clean,
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

	private async ensureControlChild(): Promise<AcpChild> {
		if (this.controlChild?.alive) return this.controlChild;
		const profile = this.pool.healthyProfiles()[0];
		if (!profile) throw this.noUsableAccountError();
		const child = await this.ensureChild(profile);
		await child.initialize(this.clientInitialize);
		this.controlChild = child;
		return child;
	}

	private async ensureSessionChild(session: SessionState): Promise<AcpChild> {
		const profile = this.pool.get(session.profile);
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
			this.ledger.bindChild(session);
			return child;
		}

		// The new process lost the conversation; create a fresh one and arm handoff.
		const created = await child.request(
			"session/new",
			buildChildNewSessionPayload({
				cwd: session.cwd,
				mcpServers: session.mcpServers,
				additionalDirectories: session.additionalDirectories,
				skills: session.skills,
				systemPromptAppend: session.systemPromptAppend,
			}),
		);
		if (created.error) throw new AcpRpcError(created.error);
		const createdResult = isRecord(created.result) ? created.result : {};
		const createdId = readString(createdResult.sessionId);
		if (!createdId) throw new Error("agent returned no sessionId for session/new");

		const { previousChildId } = this.ledger.rebind(session, {
			profile: profile.slug,
			childSessionId: createdId,
			needsHandoff: true,
			handoffSessionReady: true,
		});
		child.loadedSessions.add(createdId);
		this.log(`agent lost session ${previousChildId} on ${profile.slug}; created ${createdId}`);
		await this.ledger.save();
		return child;
	}

	// ---------------------------------------------------------------------
	// Pool helpers & failure recording
	// ---------------------------------------------------------------------

	private async rankCandidates(
		options: { modelId?: string; exclude?: string[]; allowBlocked?: boolean; prefer?: string[] } = {},
	): Promise<Profile[]> {
		return await this.pool.rankCandidates({
			...options,
			sequential: this.sequential,
			busyProfile: this.sequential ? this.ledger.profileWithActiveTurn() : undefined,
		});
	}

	private async getUsage(profile: Profile, force = false): Promise<UsageSnapshot | null> {
		if (force) return await this.probes.refreshUsage(profile).catch(() => null);
		return await this.probes.usage(profile);
	}

	private refreshServedAccount(slug: string | undefined): void {
		if (!slug) return;
		const profile = this.pool.get(slug);
		if (!profile) return;
		void this.probes.usage(profile).catch(() => {});
	}

	private async isLowQuota(profile: Profile, family: Family): Promise<boolean> {
		const snapshot = await this.getUsage(profile);
		return this.pool.isLowQuota(snapshot, family);
	}

	private async markModelUnsupported(profile: Profile, modelId: string): Promise<void> {
		await this.catalog.markUnsupported(profile, modelId);
		void this.probes.refreshModels(profile).catch(() => {});
	}

	private async recordFailure(profile: Profile, session: SessionState | undefined, kind: FailureKind): Promise<void> {
		const usageSnapshot = kind === "quota" ? await this.getUsage(profile, true) : undefined;
		const { blockedUntil } = await this.pool.recordFailure(profile.slug, kind, {
			modelId: session?.modelId,
			usageSnapshot,
		});
		if (blockedUntil !== undefined) {
			const family = familyForModel(session?.modelId);
			this.log(`blocked ${profile.slug}:${family} until ${new Date(blockedUntil).toISOString()}`);
		}
	}

	// ---------------------------------------------------------------------
	// Handshake and session lifecycle
	// ---------------------------------------------------------------------

	private async onInitialize(request: JsonRpcRequest): Promise<void> {
		this.clientInitialize = request.params;
		const candidates = this.pool.healthyProfiles();
		if (!candidates.length) throw this.noUsableAccountError();
		let lastError: unknown;
		for (const profile of candidates.slice(0, Math.min(candidates.length, 3))) {
			try {
				const child = await this.ensureChild(profile);
				const result = await child.initialize(request.params);
				this.controlChild = child;
				this.respond(request.id, augmentInitializeResult(result));
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
		await this.pool.clearAuthRequired(child.slug);
		this.respond(request.id, response.result ?? {});
	}

	private async onSessionNew(request: JsonRpcRequest): Promise<void> {
		const params = isRecord(request.params) ? request.params : {};
		const cwd = readString(params.cwd);
		if (!cwd) throw new Error("session/new requires an absolute cwd");
		const mcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : [];
		const additionalDirectories = readStringArray(params.additionalDirectories);
		const meta = readAntigravityMeta(params);
		const skills = meta.skills !== undefined ? meta.skills : this.defaultSkills;
		const payload = buildChildNewSessionPayload({
			baseParams: params,
			cwd,
			mcpServers,
			additionalDirectories,
			skills,
			systemPromptAppend: meta.systemPromptAppend,
		});

		const candidates = await this.rankCandidates({ allowBlocked: true });
		if (!candidates.length) throw this.noUsableAccountError();
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

				this.catalog.discoverFromAcpResult(profile, result);
				const models = isRecord(result.models) ? result.models : undefined;
				const modelId = models && typeof models.currentModelId === "string" ? models.currentModelId : undefined;
				const session = this.ledger.create({
					profile: profile.slug,
					childSessionId,
					cwd,
					mcpServers,
					additionalDirectories,
					skills,
					systemPromptAppend: meta.systemPromptAppend,
					modelId,
					bufferPendingOut: true,
				});
				child.loadedSessions.add(childSessionId);
				await this.ledger.save();

				for (const message of this.ledger.takeUnknownUpdates(profile.slug, childSessionId)) {
					this.handleAgentNotification(child, message);
				}
				const enriched = await this.catalog.enrichSessionResult(result, profile.slug, this.pool.healthyProfiles());
				this.respond(request.id, { ...enriched, sessionId: session.id });
				this.ledger.drainPendingOut(session, msg => this.sendToClient(msg));
				this.broadcastAvailableCommands(session);
				void this.probes.usage(profile).catch(() => {});
				return;
			} catch (error) {
				const raw = error instanceof AcpRpcError ? error.rpcError : error;
				await this.recordFailure(profile, undefined, classifyAcpError(raw));
				this.log(`session/new failed on ${profile.slug}: ${errorMessage(error)}`);
				lastError = error;
			}
		}
		throw lastError ?? new Error("session/new failed");
	}

	private async onSessionLoad(request: JsonRpcRequest, resume: boolean): Promise<void> {
		const params = isRecord(request.params) ? request.params : {};
		const requestedId = readString(params.sessionId);
		if (!requestedId) throw new Error(`${resume ? "session/resume" : "session/load"} requires sessionId`);
		const mcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : undefined;
		const additionalDirectories = readStringArray(params.additionalDirectories);

		const session = await this.ledger.resolveOrLoad(requestedId);
		if (!session) {
			const owningProfile = await this.findProfileForSessionDb(requestedId);
			const candidates = await this.rankCandidates({ allowBlocked: true });
			const profile = owningProfile ?? candidates[0];
			if (!profile) throw this.noUsableAccountError();
			const cwd = readString(params.cwd);
			if (!cwd) throw new Error(`${resume ? "session/resume" : "session/load"} requires cwd for an unknown session`);
			const child = await this.ensureChild(profile);
			await child.initialize(this.clientInitialize);

			const createdSession = this.ledger.adoptUnknown({
				id: requestedId,
				profile: profile.slug,
				cwd,
				mcpServers: mcpServers ?? [],
				additionalDirectories,
			});
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
					await this.ledger.save();
					return;
				}
				this.ledger.rollbackUnknown(createdSession);
				throw new AcpRpcError(response.error);
			}
			const result = isRecord(response.result) ? response.result : {};
			this.catalog.discoverFromAcpResult(profile, result);
			const models = isRecord(result.models) ? result.models : undefined;
			if (models && typeof models.currentModelId === "string") createdSession.modelId = models.currentModelId;
			child.loadedSessions.add(requestedId);
			this.ledger.flushLoadBuffers(createdSession);
			await this.ledger.save();
			const enriched = await this.catalog.enrichSessionResult(result, profile.slug, this.pool.healthyProfiles());
			this.respond(
				request.id,
				typeof enriched.sessionId === "string" ? { ...enriched, sessionId: requestedId } : enriched,
			);
			this.broadcastAvailableCommands(createdSession);
			this.broadcastUsageUpdate(createdSession, profile);
			return;
		}

		const profile = this.pool.get(session.profile);
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

		// Hydrate legacy mapping-only records silently on resume without duplicating client messages.
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
		this.ledger.flushLoadBuffers(session);
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
		this.catalog.discoverFromAcpResult(profile, result);
		const models = isRecord(result.models) ? result.models : undefined;
		if (models && typeof models.currentModelId === "string") session.modelId = models.currentModelId;
		session.record.cwd = cwd;
		session.record.updatedAt = new Date().toISOString();
		await this.ledger.save();
		const enriched = await this.catalog.enrichSessionResult(result, profile.slug, this.pool.healthyProfiles());
		this.respond(
			request.id,
			typeof enriched.sessionId === "string" ? { ...enriched, sessionId: requestedId } : enriched,
		);
		this.broadcastAvailableCommands(session);
		this.broadcastUsageUpdate(session, profile);
	}

	private onSessionList(request: JsonRpcRequest): void {
		const params = isRecord(request.params) ? request.params : {};
		this.respond(
			request.id,
			this.ledger.list({
				cwd: readString(params.cwd),
				cursor: readString(params.cursor),
			}),
		);
	}

	private async onSessionClose(request: JsonRpcRequest, remove: boolean): Promise<void> {
		const params = isRecord(request.params) ? request.params : {};
		const sessionId = readString(params.sessionId);
		if (!sessionId) throw new Error(`${remove ? "session/delete" : "session/close"} requires sessionId`);
		const session = this.ledger.get(sessionId);
		const record = this.ledger.getRecord(sessionId);
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
		if (remove) this.ledger.remove(sessionId);
		else this.ledger.close(sessionId);
		await this.ledger.save();
		this.releaseCandidates.add(record.profile);
		this.respond(request.id, {});
	}

	private async onSessionFork(request: JsonRpcRequest): Promise<void> {
		const params = isRecord(request.params) ? request.params : {};
		const sessionId = readString(params.sessionId);
		if (!sessionId) throw new Error("session/fork requires sessionId");
		const session = await this.ledger.resolveOrLoad(sessionId);
		if (!session) throw new Error(`unknown session: ${sessionId}`);
		const child = await this.ensureSessionChild(session);
		const response = await child.request("session/fork", { ...params, sessionId: session.childSessionId });
		if (response.error) {
			if (response.error.code !== -32601) throw new AcpRpcError(response.error);
			await this.fallbackSessionFork(request.id, session, child);
			return;
		}
		const result = isRecord(response.result) ? response.result : {};
		const forkProfile = this.pool.get(session.profile);
		if (forkProfile) this.catalog.discoverFromAcpResult(forkProfile, result);
		const childSessionId = readString(result.sessionId);
		if (!childSessionId) throw new Error("agent returned no sessionId for session/fork");
		if (childSessionId === session.childSessionId) {
			throw new Error("agent returned source sessionId for session/fork");
		}

		const models = isRecord(result.models) ? result.models : undefined;
		const modelId = models && typeof models.currentModelId === "string" ? models.currentModelId : undefined;
		const forked = this.ledger.fork(session, childSessionId, modelId, {
			needsHandoff: session.needsHandoff,
			handoffSessionReady: session.handoffSessionReady,
			fullHandoffReplay: session.fullHandoffReplay,
			bufferPendingOut: true,
		});
		child.loadedSessions.add(childSessionId);
		for (const message of this.ledger.takeUnknownUpdates(session.profile, childSessionId)) {
			this.handleAgentNotification(child, message);
		}
		await this.ledger.save();
		const enriched = await this.catalog.enrichSessionResult(result, session.profile, this.pool.healthyProfiles());
		this.respond(request.id, { ...enriched, sessionId: forked.id });
		this.ledger.drainPendingOut(forked, msg => this.sendToClient(msg));
	}

	private async fallbackSessionFork(clientId: JsonRpcId, source: SessionState, child: AcpChild): Promise<void> {
		this.log(
			`child ${source.profile} does not support session/fork (-32601); falling back to session/new + transcript replay`,
		);
		const payload = buildChildNewSessionPayload({
			cwd: source.cwd,
			mcpServers: source.mcpServers,
			additionalDirectories: source.additionalDirectories,
			skills: source.skills,
			systemPromptAppend: source.systemPromptAppend,
		});
		const created = await child.request("session/new", payload);
		if (created.error) throw new AcpRpcError(created.error);
		const createdResult = isRecord(created.result) ? created.result : {};
		const childSessionId = readString(createdResult.sessionId);
		if (!childSessionId) throw new Error("agent returned no sessionId for session/new");
		if (childSessionId === source.childSessionId) {
			throw new Error("agent returned source sessionId for session/new during fork fallback");
		}

		const forkProfile = this.pool.get(source.profile);
		if (forkProfile) this.catalog.discoverFromAcpResult(forkProfile, createdResult);
		const models = isRecord(createdResult.models) ? createdResult.models : undefined;
		const createdModelId = models && typeof models.currentModelId === "string" ? models.currentModelId : undefined;
		const modelId = source.modelId ?? createdModelId;

		const forked = this.ledger.fork(source, childSessionId, modelId, {
			needsHandoff: true,
			handoffSessionReady: true,
			fullHandoffReplay: true,
			bufferPendingOut: true,
		});
		child.loadedSessions.add(childSessionId);
		for (const message of this.ledger.takeUnknownUpdates(source.profile, childSessionId)) {
			this.handleAgentNotification(child, message);
		}
		await this.ledger.save();

		const enriched = await this.catalog.enrichSessionResult(
			createdResult,
			source.profile,
			this.pool.healthyProfiles(),
		);
		this.respond(clientId, { ...enriched, sessionId: forked.id });
		this.ledger.drainPendingOut(forked, msg => this.sendToClient(msg));
		this.broadcastAvailableCommands(forked);
	}

	private async enrichModelPayload(result: unknown, activeProfile?: string): Promise<unknown> {
		if (!isRecord(result)) return result;
		const healthy = this.pool.healthyProfiles();
		if (isRecord(result.models) && activeProfile) {
			return await this.catalog.enrichSessionResult(result, activeProfile, healthy);
		}
		if (Array.isArray(result.configOptions)) {
			return await this.catalog.enrichConfigOptionsResult(result, healthy);
		}
		return result;
	}

	private async onGenericRequest(request: JsonRpcRequest): Promise<void> {
		const params = isRecord(request.params) ? request.params : {};
		const sessionId = readString(params.sessionId);
		const session = sessionId ? this.ledger.get(sessionId) : undefined;
		if (session && request.method === "session/set_model") {
			const modelId = readString(params.modelId);
			if (modelId) {
				await this.handleModelChangeRequest(request, session, modelId, params);
				return;
			}
		}
		if (session && request.method === "session/set_config_option") {
			if (readString(params.configId) === "model" && typeof params.value === "string") {
				await this.handleModelChangeRequest(request, session, params.value, params);
				return;
			}
		}

		const child = session ? await this.ensureSessionChild(session) : await this.ensureControlChild();
		const payload = session ? { ...params, sessionId: session.childSessionId } : params;
		const response = await child.request(request.method, payload);
		if (response.error) throw new AcpRpcError(response.error);
		const enriched = await this.enrichModelPayload(response.result ?? {}, session?.profile ?? child.slug);
		this.respond(request.id, enriched);
	}

	private async handleModelChangeRequest(
		request: JsonRpcRequest,
		session: SessionState,
		modelId: string,
		params: Record<string, unknown>,
	): Promise<void> {
		session.modelId = modelId;
		session.record.updatedAt = new Date().toISOString();
		const currentProfile = this.pool.get(session.profile);
		const family = familyForModel(modelId);

		let unsupportedOnCurrent = false;
		let lastUnsupportedError: AcpRpcError | undefined;
		if (currentProfile) {
			const currentModels = await this.probes.models(currentProfile);
			if (currentModels) this.catalog.remember(currentModels);
			unsupportedOnCurrent =
				isModelKnownUnsupported(currentModels, modelId) ||
				(await this.pool.isReservedFor(currentProfile.slug, modelId, { sequential: this.sequential }));
		}

		if (currentProfile && !unsupportedOnCurrent) {
			const child = await this.ensureSessionChild(session);
			const response = await child.request(request.method, { ...params, sessionId: session.childSessionId });
			if (!response.error) {
				if (this.pool.isBlocked(currentProfile.slug, family) || (await this.isLowQuota(currentProfile, family))) {
					session.needsHandoff = true;
					session.handoffSessionReady = false;
				}
				await this.ledger.save();
				const enriched = await this.enrichModelPayload(response.result ?? {}, currentProfile.slug);
				this.respond(request.id, enriched);
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
					await this.paceAccountSwitch(session.profile, candidate.slug);
					const nextChild = await this.ensureChild(candidate);
					await nextChild.initialize(this.clientInitialize);
					const created = await nextChild.request(
						"session/new",
						buildChildNewSessionPayload({
							cwd: session.cwd,
							mcpServers: session.mcpServers,
							additionalDirectories: session.additionalDirectories,
							skills: session.skills,
							systemPromptAppend: session.systemPromptAppend,
						}),
					);
					if (created.error) throw new AcpRpcError(created.error);
					const createdResult = isRecord(created.result) ? created.result : {};
					const createdId = readString(createdResult.sessionId);
					if (!createdId) throw new Error("agent returned no sessionId for session/new");
					this.catalog.discoverFromAcpResult(candidate, createdResult);

					const apply = await nextChild.request(request.method, { ...params, sessionId: createdId });
					if (apply.error) {
						nextChild.loadedSessions.delete(createdId);
						void nextChild.request("session/close", { sessionId: createdId }).catch(() => {});
						this.releaseCandidates.add(candidate.slug);
						if (isModelUnsupportedError(apply.error)) {
							lastUnsupportedError = new AcpRpcError(apply.error);
							await this.markModelUnsupported(candidate, modelId);
							continue;
						}
						throw new AcpRpcError(apply.error);
					}

					const { previousProfile, previousChildId } = this.ledger.rebind(session, {
						profile: candidate.slug,
						childSessionId: createdId,
						needsHandoff: false,
						handoffSessionReady: false,
					});
					nextChild.loadedSessions.add(createdId);
					this.closePreviousChildSession(previousProfile, previousChildId);
					this.log(`switched session ${session.id} to ${candidate.slug} for model ${modelId}`);
					await this.ledger.save();
					const enriched = await this.enrichModelPayload(apply.result ?? {}, candidate.slug);
					this.respond(request.id, enriched);
					return;
				} catch (error) {
					if (!(error instanceof AcpRpcError) || !isModelUnsupportedError(error.rpcError)) {
						throw error;
					}
					lastUnsupportedError = error;
				}
			}
			if (lastUnsupportedError) throw lastUnsupportedError;
			throw new Error(`no available account supports model ${modelId}`);
		}

		if (candidates.length > 0) {
			session.needsHandoff = true;
			session.handoffSessionReady = false;
			await this.ledger.save();
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

	private async runSessionPrompt(request: JsonRpcRequest): Promise<void> {
		const params = isRecord(request.params) ? request.params : {};
		const sessionId = readString(params.sessionId);
		const session = sessionId ? this.ledger.get(sessionId) : undefined;
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

		const multiUsageMatch = userText.trim().match(/^\/multi-usage(?:\s+(.*))?$/i);
		if (multiUsageMatch) {
			const forceRefresh = /\b(?:--refresh|refresh)\b/i.test(multiUsageMatch[1] ?? "");
			await this.handleMultiUsageCommand(request.id, session, forceRefresh);
			return;
		}

		session.history.push({ role: "user", text: userText });
		const family = familyForModel(session.modelId);
		const current = this.pool.get(session.profile);
		let target = current;
		let handoff = Boolean(session.needsHandoff);

		if (!current) {
			const next = (await this.rankCandidates({ modelId: session.modelId, allowBlocked: false }))[0];
			if (!next) {
				session.history.pop();
				this.respondError(request.id, -32000, "no available accounts");
				return;
			}
			target = next;
			handoff = true;
		} else {
			const blocked = this.pool.isBlocked(current.slug, family);
			const low = await this.isLowQuota(current, family);
			const currentModels = await this.probes.models(current);
			if (currentModels) this.catalog.remember(currentModels);
			const unsupported =
				isModelKnownUnsupported(currentModels, session.modelId) ||
				(await this.pool.isReservedFor(current.slug, session.modelId, { sequential: this.sequential }));
			const unhealthy = Boolean(current.bannedAt || current.authRequiredAt) || blocked || unsupported;
			if (unhealthy || low) {
				const next = (
					await this.rankCandidates({
						modelId: session.modelId,
						exclude: [current.slug],
						allowBlocked: false,
					})
				)[0];
				if (next) {
					target = next;
					handoff = true;
				} else if (unhealthy) {
					const until = current.bannedAt ? undefined : this.pool.blockReset(current.slug, session.modelId);
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
		await this.paceAccountSwitch(session.profile, target.slug);
		await this.runPrompt(request.id, session, userText, target, handoff, 0);
	}

	private async handleMultiUsageCommand(
		clientId: JsonRpcId,
		session: SessionState,
		forceRefresh: boolean,
	): Promise<void> {
		const profiles = this.pool.list();
		if (forceRefresh && !this.sequential && profiles.length) {
			await this.probes.syncAll(profiles, { usage: true, force: true }).catch(() => {});
		}
		const entries = await Promise.all(
			profiles.map(async profile => ({
				profile,
				snapshot:
					profile.disabled || profile.bannedAt || profile.authRequiredAt
						? null
						: await readCachedUsage(profile.slug),
			})),
		);
		this.sendToClient({
			jsonrpc: "2.0",
			method: "session/update",
			params: {
				sessionId: session.id,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: formatMultiUsageReport(entries) },
				},
			},
		});
		this.respond(clientId, { stopReason: "end_turn" });
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
					this.ledger.getByChild(profile.slug, session.childSessionId) === session &&
					child.loadedSessions.has(session.childSessionId);
				const resumed =
					!ready && !session.fullHandoffReplay && session.childSessionId && session.profile !== profile.slug
						? await child.request("session/resume", {
								sessionId: session.childSessionId,
								cwd: session.cwd,
								mcpServers: session.mcpServers,
								...(session.additionalDirectories
									? { additionalDirectories: session.additionalDirectories }
									: {}),
							})
						: undefined;
				const resumedNative = Boolean(resumed && !resumed.error);
				if (resumedNative) {
					const { previousProfile, previousChildId } = this.ledger.rebind(session, {
						profile: profile.slug,
						childSessionId: session.childSessionId,
						needsHandoff: false,
						handoffSessionReady: true,
						fullHandoffReplay: false,
					});
					child.loadedSessions.add(session.childSessionId);
					this.closePreviousChildSession(previousProfile, previousChildId);
					this.log(`resumed conversation ${session.childSessionId} on ${profile.slug}`);
					await this.ledger.save();
				} else if (!ready) {
					const created = await child.request(
						"session/new",
						buildChildNewSessionPayload({
							cwd: session.cwd,
							mcpServers: session.mcpServers,
							additionalDirectories: session.additionalDirectories,
							skills: session.skills,
							systemPromptAppend: session.systemPromptAppend,
						}),
					);
					if (created.error) throw new AcpRpcError(created.error);
					const createdResult = isRecord(created.result) ? created.result : {};
					const createdId = readString(createdResult.sessionId);
					if (!createdId) throw new Error("agent returned no sessionId for handoff session/new");
					this.catalog.discoverFromAcpResult(profile, createdResult);

					const { previousProfile, previousChildId } = this.ledger.rebind(session, {
						profile: profile.slug,
						childSessionId: createdId,
						needsHandoff: true,
						handoffSessionReady: true,
					});
					child.loadedSessions.add(createdId);
					this.closePreviousChildSession(previousProfile, previousChildId);

					const models = isRecord(createdResult.models) ? createdResult.models : undefined;
					if (!session.modelId && models && typeof models.currentModelId === "string") {
						session.modelId = models.currentModelId;
					}
					await this.ledger.save();
				}

				if (session.modelId) {
					const setModel = await child.request("session/set_model", {
						sessionId: session.childSessionId,
						modelId: session.modelId,
					});
					if (setModel.error) {
						if (isModelUnsupportedError(setModel.error) && switches < this.maxSwitches) {
							await this.markModelUnsupported(profile, session.modelId);
							const next = (
								await this.rankCandidates({
									modelId: session.modelId,
									exclude: [profile.slug],
									allowBlocked: false,
								})
							)[0];
							if (next) {
								await this.paceAccountSwitch(profile.slug, next.slug);
								await this.runPrompt(clientId, session, originalText, next, true, switches + 1);
								return;
							}
						}
						throw new AcpRpcError(setModel.error);
					}
				}
				const replayMaxChars = session.fullHandoffReplay ? 0 : this.handoffContextChars;
				text = resumedNative
					? originalText
					: buildHandoffPrompt({ history: session.history, maxChars: replayMaxChars }) || originalText;
			}

			const transport = this.transportFor(child);
			const outcome = await this.turns.executePrompt({
				session,
				text,
				suppressUserChunk: handoff,
				transport,
				beforePrompt: async () => {
					await this.ledger.save();
					this.log(`prompt on ${profile.slug}${handoff ? " (handoff)" : ""} session=${session.id}`);
				},
			});

			if (outcome.status === "hold_exhausted") {
				this.respondError(
					clientId,
					-32000,
					`turn ended with unconfirmed background tasks: ${outcome.taskIds.join(", ")}. ` +
						"The work may still be running; no verified result was produced.",
				);
				return;
			}
			if (outcome.status === "cancelled") {
				this.log(`prompt cancelled on ${profile.slug} session=${session.id}`);
				this.respond(clientId, { stopReason: "cancelled" });
				return;
			}
			if (outcome.status === "error") {
				const { error, turn } = outcome;
				const isLost = isSessionLostError(error);
				const isUnsupportedModel = Boolean(session.modelId) && isModelUnsupportedError(error);
				const kind = classifyAcpError(error);
				this.log(
					`prompt failed on ${profile.slug}: ${isLost ? "session_lost" : isUnsupportedModel ? "model_unsupported" : kind}: ${error.message}`,
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
					const next = (
						await this.rankCandidates({
							modelId: session.modelId,
							exclude: [profile.slug],
							allowBlocked: false,
						})
					)[0];
					if (next) {
						await this.paceAccountSwitch(profile.slug, next.slug);
						await this.runPrompt(clientId, session, originalText, next, true, switches + 1);
						return;
					}
				}
				if (turn.forwardedOutput && turn.assistantText.trim()) {
					session.history.push({ role: "assistant", text: turn.assistantText.trim() });
				}
				if (switchable) {
					session.needsHandoff = true;
					session.handoffSessionReady = false;
				}
				session.record.updatedAt = new Date().toISOString();
				await this.ledger.save();
				this.respondError(clientId, error.code, error.message, error.data);
				return;
			}

			const { result: rawResult, turn } = outcome;
			const result = isRecord(rawResult) ? rawResult : {};
			const stopReason = readString(result.stopReason) ?? "end_turn";
			if (turn.assistantText.trim()) {
				session.history.push({ role: "assistant", text: turn.assistantText.trim() });
			}
			session.needsHandoff = false;
			session.handoffSessionReady = false;
			session.fullHandoffReplay = false;
			session.record.updatedAt = new Date().toISOString();
			await this.pool.recordSuccess(profile.slug);
			await this.ledger.save();

			const autoCompacted = await this.turns.maybeAutoCompact({
				session,
				profileSlug: profile.slug,
				profileHomeDir: profileHomeOf(profile),
				transport,
			});
			if (!turn.seenUsageUpdate || autoCompacted) {
				this.broadcastUsageUpdate(session, profile);
			}

			this.respond(clientId, rawResult ?? { stopReason });
			this.refreshServedAccount(session.profile);
		} catch (error) {
			session.activeTurn = undefined;
			this.respondFailure(clientId, error);
		}
	}

	private async findProfileForSessionDb(sessionId: string): Promise<Profile | undefined> {
		for (const profile of this.pool.list()) {
			const dbPath = join(profileHome(profile.slug), ".gemini", "antigravity-cli", "conversations", `${sessionId}.db`);
			if (await exists(dbPath)) return profile;
		}
		return undefined;
	}
}

export async function runAcpProxy(options: AcpProxyOptions = {}): Promise<void> {
	// Provisioning failures stay fatal: a keychain that cannot be unlocked must be
	// reported, never silently skipped. The shared store is race-tolerant instead.
	await syncProfiles();
	const proxy = new AcpProxy(options);
	await proxy.start();
}
