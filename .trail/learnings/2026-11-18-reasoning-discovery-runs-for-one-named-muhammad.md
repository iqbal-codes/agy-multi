---
title: Reasoning discovery runs for one named account and uses supported ACP flags
author: Muhammad
date: 2026-11-18
branch: main
id: l-2b01ecbb
scope: repo
status: active
src: agent
touches:
  - src/index.ts
---

## Decided
Run reasoning discovery only after logging in or explicitly syncing one named account. A bare profile sync should keep its existing role of provisioning shared configuration. Print the reasoning cache count separately because a successful provisioning message does not establish model discovery.

## Tried and ruled out
The installed Antigravity CLI rejects the print-mode slash-command flag when passed to its ACP subcommand. The original synthetic agent accepted any flags, so its integration test missed the deployed failure. Removing that flag exposed five valid reasoning catalogs on one live account.

## Watch out
Verify the executable the client actually launches when testing local changes. Both standalone binaries can retain the release version string after a local rebuild.

In the code: use `agy-multi profile sync <slug>`, and use `agy acp --include-default-customizations=false` for the metadata probe. The cache file is `model-reasoning.json` inside the profile directory.
