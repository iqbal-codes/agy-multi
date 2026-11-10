---
title: ACP auto-recovery for lost trajectories and concurrent session persistence
author: Muhammad
date: 2026-11-10
branch: main
id: l-0c3d51f9
scope: repo
status: active
src: agent
touches:
  - src/acp/server.ts
  - src/acp/session-store.ts
  - src/classify.ts
  - src/fs-utils.ts
  - src/injection.ts
  - src/profile.ts
  - test/acp-classify.test.ts
  - test/acp-persistence.test.ts
  - test/injection.test.ts
---

## Decided
- In multi-process ACP (such as T3 Code reconnecting or spawning instances), saveAcpSessions merges on-disk sessions rather than overwriting the whole file with process-local state.
- When an unknown session or reconnected session is loaded, agy-multi first checks on-disk profile conversation databases (.gemini/antigravity-cli/conversations/<id>.db) to bind to the true owning profile rather than defaulting to the first candidate.
- If child agy returns 'trajectory not found' or 'session not found' on session/prompt, isSessionLostError identifies it as a lost child trajectory and recovers by requesting session/new on the child and re-running the turn via handoff with session.history.

## Watch out
- Official agy does not validate SQLite trajectory existence on session/load; it only returns 'trajectory not found' once session/prompt executes SEND_USER_CASCADE_MESSAGE. Handing off at the session/prompt boundary is the reliable safety net.
- Multi-account failover must only mark profiles quota-blocked/banned on actual quota/ban errors, not when a trajectory was simply absent on a healthy account.
