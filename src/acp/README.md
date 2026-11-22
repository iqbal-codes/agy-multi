# src/acp — ACP Proxy

## Overview

`src/acp` is the stdio ACP front end: one process speaks newline-delimited JSON-RPC 2.0
and fronts one `agy acp` child per profile. [`server.ts`](./server.ts) is a thin router
that delegates pool ranking/state to [`AccountPool`](../account-pool.ts), model/reasoning
catalogs to [`ModelCatalog`](../model-catalog.ts), parallel probing to
[`ProbeSync`](../probe-sync.ts), session identity and persistence to
[`SessionLedger`](./session-ledger.ts), and in-flight turn supervision to
[`TurnSupervisor`](./turn-supervisor.ts).

## Interface

- **Router & child:** [`runAcpProxy`](./server.ts) awaits `syncProfiles()`, builds
  `AcpProxy`, binds stdio immediately, and triggers non-blocking parallel background
  auto-sync in pool mode. [`AcpChild`](./child.ts) manages one detached `agy acp`
  process per profile; [`rpc.ts`](./rpc.ts) provides `parseJsonRpc`/`LineReader`/`LineWriter`.
- **Session Ledger:** [`SessionLedger`](./session-ledger.ts) owns `sessions`,
  `sessionsByChild`, tombstoned `AcpSessionStore` persistence, atomic `rebind()`,
  load-replay/outbound buffering, and verbatim transcript handoff (`promptToText`,
  `renderHistory`, `buildHandoffPrompt`).
- **Turn Supervisor:** [`TurnSupervisor`](./turn-supervisor.ts) supervises active turns
  behind a `TurnTransport` seam (`AcpChild` in prod, in-memory fake in tests), owning
  stream chunk tracking, Daemon Hold continuations (120-continuation / 1 h cap),
  post-turn Auto-Compaction (30 s race under `suppressOutput`), and transcript-based
  `usage_update` synthesis.
- **CLI & reasoning probe:** [`parseAcpProxyOptions`](./cli-args.ts) owns all ACP argv
  flag extraction (`extractFlagArg`, `extractCompactionThresholdArg`).
  [`syncProfileModelReasoning`](./model-reasoning.ts) discovers reasoning levels via an
  abortable throwaway ACP session.

## Invariants

- **Stable proxy IDs & atomic rebinding.** `SessionLedger.rebind()` updates proxy↔child
  indices and persisted records together so notifications never drop on handoff or
  trajectory recovery.
- **One turn, no retry after output.** Failover is limited to `session_lost`,
  `model_unsupported`, `quota`, `banned`, and `auth` before any output is forwarded,
  with `--switch-delay` defaulting to 10 s.
- **Resume before replay.** Cross-profile handoff tries `session/resume` on the shared
  conversation store first and falls back to `session/new` + verbatim transcript replay.
- **Transparent `session/fork` fallback.** `initialize` augments `agentCapabilities` to
  advertise `sessionCapabilities.fork = {}` (preserving existing `sessionCapabilities` /
  `session_capabilities`). `session/fork` calls the child's native `session/fork` first
  (fast path). Only when the child rejects it with JSON-RPC `-32601` (method not found)
  does the proxy fall back to creating a fresh child session via `session/new` (copying
  `cwd`, `mcpServers`, and `additionalDirectories`), registering a new forked proxy
  session with `needsHandoff`, `handoffSessionReady`, and full-history replay armed, and
  replaying the copied text transcript on the fork's first prompt. Non-`-32601` child
  errors propagate unchanged. The source session remains completely unchanged and keeps
  its own child session. Emulated fork is text transcript replay, not a byte-for-byte
  clone of native tool-call snapshots or internal child state.
- **Consistent catalog enrichment.** `session/new`, `session/load`, `session/resume`,
  and `session/fork` all enrich results through `ModelCatalog.enrichSessionResult` and
  filter outbound responses to public Gemini releases.
- **Opt-in sequential mode.** `--sequential` keeps one active child at a time, skips
  background startup auto-sync, disables model reservation, and parks new sessions on a
  mid-turn profile.

## Verification

```sh
bun run typecheck && bun test
```
