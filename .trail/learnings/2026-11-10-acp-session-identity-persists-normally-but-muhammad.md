---
title: ACP session identity persists normally but context reporting and recovery are lossy
author: Muhammad
date: 2026-11-10
branch: main
id: l-2d00b247
scope: repo
status: active
src: agent
touches:
  - src/acp/server.ts
  - src/acp/session-store.ts
  - src/acp/token-usage.ts
  - src/acp/prompt.ts
  - test/acp-proxy.test.ts
  - test/acp-persistence.test.ts
  - test/token-usage.test.ts
---

## Decided
- Audit: ordinary consecutive session/prompt requests reuse the same profile, child process, and childSessionId; live account-4 logs acp-31872.log show 8 prompts on de418463-2457-474d-b772-7c5d175c48c6. Live transcripts show SYSTEM CHECKPOINT followed by context shrinkage on unchanged conversation IDs (260047 to 35267 at steps 327/328; 260650 to 34834 at steps 462/463). Treat proxy identity, backend identity, active context occupancy, and cumulative billable tokens separately. getModelContextSize is a hardcoded family guess, not authoritative model/backend metadata.
## Tried and ruled out
- Ran all 49 existing tests and typecheck successfully, but they do not cover these failures. Isolated JSON-RPC harness reproduced: native usage_update overwritten by proxy fallback estimate; restart + session/resume retains child identity but leaves proxy history empty, so later failover omits pre-restart turns; prompt after child exit spawns fresh child without resume and fails unknown session; transcript row over 64KiB causes token reader to return null. Ordinary second prompt creating a new conversation was ruled out for the observed live logs and isolated normal-turn test.
## Watch out
- Initial audit changed no production code and sent no live generation prompts. Subsequent fixes are recorded below. 22/30 stored session mappings had no matching transcript at audit time, but some may be unused/empty sessions. Observed checkpoint near 260k is not proof of a model's advertised maximum context. Failover explicitly changes child session while preserving proxy ID and only carries rendered user/assistant text (60000-character budget), not full tool state. Native usage overwrite reproduction used an isolated synthetic agent, not proof that installed agy emits native usage_update.

## Diagnosis and fixes
- Regression command: `bun test test/acp-persistence.test.ts test/token-usage.test.ts`. Before fixes: 8 failures / 6 passes. Additional legacy-store and storage-failure checks were independently red before their fixes.
- Prompt execution now calls ensureSessionChild on ordinary turns; dead child processes resume before prompting, and lost sessions reuse one replacement with selected model + history handoff.
- Session records persist user/assistant history, model and handoff state. Replay does not duplicate persisted history or replace cross-account history with only the current child's replay. Legacy mapping-only resume silently loads history first. Atomic storage errors propagate to the requesting turn; failed writes do not poison the save queue.
- Synthetic usage updates, hardcoded capacity guesses and character-count context estimates were removed. Native usage updates pass through with proxy session ID rewriting. If the agent supplies no capacity/usage, ACP context reporting is unavailable rather than fabricated. Transcript token parsing scans complete lines across 64KiB blocks and permits measured context decreases after checkpoints.
- Model rejection on handoff fails the turn instead of silently using the default. Existing handoff's 60,000-character text budget and loss of in-memory tool state remain explicit limitations; a hard proxy kill can still interrupt streaming before the complete assistant text is saved.
- Verification: initial full suite 63 passes; focused 17 tests repeated three times (51 passes); typecheck and git diff --check pass. Integration tests use isolated stateful fake agent processes; installed binaries and live T3 sessions were not changed or exercised.
- Realtime follow-up: added an integration test holding session/prompt open while emitting three separate usage_update events (including a context decrease). Each update reaches the client before the prompt response resolves. Test passes three consecutive runs; full suite now 64 passes. No production buffering change was needed: handleAgentNotification already forwards native usage immediately. At the realtime audit, the installed older binary still had end-of-turn synthetic reporting; deployment is recorded below. Agent-side frequency of native usage events remains unverified; absence of usage_update strings in logs is not proof of absence on the ACP wire. Do not claim realtime from actual AGY/T3 until that boundary is exercised. Transcript tokens alone do not establish model capacity, so no guessed percentage meter was added.
- Deployment: built both executables with bun run build, ad-hoc signed and strictly verified on macOS, and installed through sibling-file atomic renames to ~/.local/bin/agy-multi and agy-multi-acp. Old binaries backed up under ~/.local/share/agy-multi/backups/20261110-121914-12038. SHA-256 matches signed dist artifacts. Installed executable integration coverage: 12 passes for agy-multi acp and 12 passes for agy-multi-acp using isolated fake agents, including updates arriving during an active prompt. Existing T3/provider processes were deliberately not interrupted; restart/reconnect is required to load the new executable. Actual official AGY event cadence and T3 UI rendering remain unverified.
