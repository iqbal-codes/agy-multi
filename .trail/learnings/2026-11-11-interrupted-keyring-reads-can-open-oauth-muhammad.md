---
title: Interrupted keyring reads can open OAuth during background quota checks
author: Muhammad
date: 2026-11-11
branch: main
id: l-82c49296
scope: repo
status: active
src: agent
touches:
  - src/usage.ts
  - src/acp/server.ts
---

## Decided
A cancelled keyring read is not logout. The official CLI can fall back to interactive OAuth and invoke macOS open despite BROWSER. Isolate quota checks from the host process group; cancel their owned group with SIGKILL so neither the CLI nor its credential reader can enter OAuth during shutdown.

In the code:
- The real 11:54:54 main usage log recorded signal: terminated, silent auth failed, then triggering interactive OAuth while T3's periodic probe finished.
- src/usage.ts owns an isolated quota process group; timeout/AbortSignal hard-stop it. src/acp/server.ts aborts quota operations before shutdown, including checks still awaiting credential presence.
- test/usage-lifecycle.test.ts reproduced browser attempts before the fix and verifies host-group signals, cancellation, timeout, successful quota caching, and ACP stdin closure afterward.
- A real-CLI probe confirmed cancelled keyring reads no longer launch OAuth when cancelling the owning operation; ordinary quota requests still succeed.

## Tried and ruled out
Ordinary profile probes succeed. BROWSER and AGY_CLI_NONINTERACTIVE_HEADLESS do not prevent the observed OAuth fallback. A second auth implementation was unnecessary for the demonstrated cancellation bug.

## Watch out
main adopts HOME via profile.home. Use the actual profile HOME and unique capture files. Original signal ownership remains unproven; the fix covers host-group teardown and wrapper cancellation, not arbitrary external termination of a credential reader. Never mark an account logged out from this error alone.
