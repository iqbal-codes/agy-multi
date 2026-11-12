---
title: Map Antigravity transcript tokens to ACP usage_update for T3 Code context indicator
author: Muhammad
date: 2026-11-11
branch: main
id: l-392a7bf4
scope: repo
status: active
replaces: l-2d00b247
src: agent
touches:
  - src/acp/server.ts
  - src/acp/token-usage.ts
  - test/acp-persistence.test.ts
  - test/token-usage.test.ts
---

## Decided
- In T3 Code, context window indicator rendering in Thread Details relies on ACP session/update notifications with sessionUpdate: 'usage_update' (providing 'used' tokens and model capacity 'size').
- Official Antigravity CLI records actual step tokens (input_tokens, cache_read_tokens, output_tokens) in transcript.jsonl but does not emit usage_update on the ACP wire.
- agy-multi resolves measured token occupancy from transcript.jsonl via resolveSessionTokenUsage and broadcasts usage_update at turn end and session load/resume.
- Native usage_update events from the child agent are preserved and forwarded immediately without being overwritten.
## Watch out
- Do not fabricate usage when transcript.jsonl does not exist.
- Use model-aware context window sizes (1,048,576 for Gemini Flash, 2,097,152 for Pro, 200,000 for Claude, 128,000 for GPT).
