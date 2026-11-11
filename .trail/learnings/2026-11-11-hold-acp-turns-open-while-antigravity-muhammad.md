---
title: Hold ACP turns open while Antigravity daemon tasks run
author: Muhammad
date: 2026-11-11
branch: main
id: l-3268445d
scope: repo
status: active
src: agent
touches:
  - src/acp/server.ts
  - src/profile.ts
---

## Decided
- ACP daemon tasks (manage_task/schedule) are invisible on the wire and encrypted in the native trajectory, so the proxy cannot read task state. Instead of guessing, the proxy holds the turn: a mirrored `schedule` TimerCondition arms a hold, `kill/stop/cancel` releases it, a bare `manage_task status` only refreshes an already-armed wait (it must not arm one, or a poll after completion holds forever). On end_turn with an armed wait the proxy sleeps until the runtime timer and sends a proxy-owned continuation prompt, bounded by 120 continuations / 60 minutes, then fails the turn honestly instead of reporting end_turn.
## Watch out
- Only an explicit runtime timer arms a hold; a status poll must not. GEMINI.md rules are now a versioned managed block — legacy unmarked installs are replaced, and user text before the block is preserved.
