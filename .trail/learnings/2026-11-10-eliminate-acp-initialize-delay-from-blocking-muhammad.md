---
title: Eliminate ACP initialize delay from blocking multi-account quota preflights
author: Muhammad
date: 2026-11-10
branch: main
id: l-859668b6
scope: repo
status: active
src: agent
touches:
  - install.ps1
  - install.sh
  - src/acp/server.ts
  - src/injection.ts
  - src/paths.ts
  - src/profile.ts
  - src/runner.ts
  - src/usage.ts
  - test/acp-proxy.test.ts
  - test/usage.test.ts
---

## Decided
- onInitialize and ensureControlChild use getHealthyProfiles() locally instead of invoking rankCandidates with live network quota preflights. ACP initialize is a pure capability handshake and returns identical protocol capabilities regardless of quota.
- Quota snapshots are persisted to disk atomically under each profile directory (usage.json) whenever fetchUsage succeeds.
- getUsage serves fresh disk cache immediately, returns stale disk cache immediately while triggering background refresh, and returns unmeasured null immediately when no cache exists without blocking turns or session creation.
- rankProfiles gracefully handles unmeasured profiles by putting them in aboveReserve pool so session creation remains sub-second.

## Tried and ruled out
- Blocking on live agy -p /usage across all 6 accounts during onInitialize caused 10-13s stalls on every ACP startup.
- In-memory only cache was cold on every ACP spawn, forcing full quota re-queries even when no tokens were generated.

## Verification
- Initialize latency measured directly: dropped from 13,028ms down to ~220ms (and ~70ms on raw child).
- All 72 unit and integration tests pass.
