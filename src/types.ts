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
	version: 1;
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
