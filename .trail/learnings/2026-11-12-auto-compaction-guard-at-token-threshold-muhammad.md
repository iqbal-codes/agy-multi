---
title: Auto-compaction guard at configurable token threshold
author: Muhammad
date: 2026-11-12
branch: main
id: l-478129ac
scope: repo
status: active
src: agent
touches:
  - src/acp/server.ts
  - src/acp/token-usage.ts
  - src/index.ts
  - src/acp-bin.ts
---

## Decided
- Long-running agents blow through model quota and rate limits when conversation trajectories reach hundreds of thousands of tokens, because every subsequent turn resends the entire accumulated context.
- While native Antigravity supports `/compact` and automatic compaction, its internal thresholds are not user-configurable. In `agy-multi`, the ACP proxy reads the latest step in `transcript.jsonl` via `resolveSessionTokenUsage`. When `usedTokens >= compactionThreshold` (default: 300,000 tokens), the proxy transparently executes `/compact` on the child session right after the successful prompt turn.
- The compaction turn sets `suppressOutput: true` so the client's conversation view is unaffected by maintenance chunks.
- If compaction fails or times out (30s), it logs a warning without failing the user prompt. Setting threshold to `0` disables auto-compaction.
## Watch out
- Do not deliver `agent_message_chunk`, `tool_call`, or `plan` updates during the compaction maintenance turn to the client; only let usage updates pass through so context meters stay accurate.
