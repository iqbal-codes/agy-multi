import { STATE_PATH } from "./paths";
import type { Checkpoint, Family, WrapperState } from "./types";
import { readJson, writeJsonAtomic } from "./fs-utils";

const EMPTY: WrapperState = { version: 1, pins: {}, blocks: {}, checkpoints: {} };

export async function loadState(): Promise<WrapperState> {
	const state = await readJson<WrapperState>(STATE_PATH, EMPTY);
	return {
		version: 1,
		pins: state.pins ?? {},
		blocks: state.blocks ?? {},
		checkpoints: state.checkpoints ?? {},
	};
}

export async function saveState(state: WrapperState): Promise<void> {
	await writeJsonAtomic(STATE_PATH, state);
}

export function isBlocked(state: WrapperState, slug: string, family: Family, now: number): boolean {
	const until = state.blocks[slug]?.[family];
	return typeof until === "number" && until > now;
}

export function block(state: WrapperState, slug: string, family: Family, untilMs: number): void {
	state.blocks[slug] ??= {};
	state.blocks[slug][family] = untilMs;
}

export function pinnedProfile(state: WrapperState, conversationId: string | undefined): string | undefined {
	return conversationId ? state.pins[conversationId] : undefined;
}

export function pin(state: WrapperState, conversationId: string, slug: string): void {
	state.pins[conversationId] = slug;
}

export function setCheckpoint(state: WrapperState, conversationId: string, checkpoint: Checkpoint): void {
	state.checkpoints[conversationId] = checkpoint;
}

export function getCheckpoint(state: WrapperState, conversationId: string | undefined): Checkpoint | undefined {
	return conversationId ? state.checkpoints[conversationId] : undefined;
}
