export type Family = "gemini" | "claude-gpt";
export type WindowId = "fiveHour" | "weekly";

export interface UsageWindow {
	family: Family;
	window: WindowId;
	remainingPct: number;
	resetsAt: string;
}

export interface UsageSnapshot {
	profile: string;
	fetchedAt: number;
	windows: UsageWindow[];
	raw: string;
}

export interface ModelInfo {
	modelId: string;
	name?: string;
}

export interface ModelsSnapshot {
	profile: string;
	fetchedAt: number;
	models: ModelInfo[];
	configOptions?: ModelConfigOption[];
}

export interface ModelConfigOption {
	value: string;
	name?: string;
}

export type FailureKind = "ok" | "banned" | "quota" | "auth" | "transient" | "error";

export interface Profile {
	slug: string;
	/** Overrides the wrapper-managed HOME (used to adopt an existing install). */
	home?: string;
	email?: string;
	createdAt: string;
	lastLoginAt?: string;
	lastGenerationOkAt?: string;
	bannedAt?: string;
	bannedReason?: string;
	authRequiredAt?: string;
	disabled?: boolean;
	disabledAt?: string;
	clean?: boolean;
}

export interface Checkpoint {
	conversationId?: string;
	prompt: string;
	response?: string;
	slug: string;
	updatedAt: string;
	cwd?: string;
	gitHead?: string;
}

export interface WrapperState {
	/** 1 = legacy shape from before `defaultProfile`; `loadState` normalises to 2. */
	version: 1 | 2;
	/**
	 * Profile used when no `--profile` is passed. Accounts are selected by the
	 * operator, never by the wrapper: `agy-multi use <slug>` writes this.
	 */
	defaultProfile?: string;
	/** Legacy pool mode only: conversation -> owning profile. */
	pins: Record<string, string>;
	blocks: Record<string, Partial<Record<Family, number>>>;
	checkpoints: Record<string, Checkpoint>;
}

export interface AgyResultEvent {
	conversation_id?: string;
	status?: string;
	response?: string;
	usage?: Record<string, number>;
}

export interface RunOutcome {
	exitCode: number;
	result?: AgyResultEvent;
	stdout: string;
	stderr: string;
	logPath: string;
}
