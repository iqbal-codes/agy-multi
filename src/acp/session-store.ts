import { ACP_SESSIONS_PATH } from "../paths";
import { readJson, writeJsonAtomic } from "../fs-utils";

/**
 * A proxy session id is what t3code sees. It stays stable across account
 * switches; the child session id is the conversation id inside one profile.
 */
export interface AcpSessionRecord {
	id: string;
	profile: string;
	childSessionId: string;
	cwd: string;
	additionalDirectories?: string[];
	mcpServers?: unknown[];
	title?: string;
	createdAt: string;
	updatedAt: string;
	closedAt?: string;
}

export interface AcpSessionStore {
	version: 1;
	sessions: Record<string, AcpSessionRecord>;
}

const EMPTY: AcpSessionStore = { version: 1, sessions: {} };

export async function loadAcpSessions(path = ACP_SESSIONS_PATH): Promise<AcpSessionStore> {
	const store = await readJson<AcpSessionStore>(path, EMPTY);
	return { version: 1, sessions: store.sessions ?? {} };
}

export async function saveAcpSessions(store: AcpSessionStore, path = ACP_SESSIONS_PATH): Promise<void> {
	await writeJsonAtomic(path, store);
}
