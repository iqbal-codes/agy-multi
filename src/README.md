# src

## Overview

`src/` is the engine behind both executables. [`index.ts`](./index.ts) is the
`agy-multi` CLI entry (`main`, `HELP`): it dispatches `acp` to `runAcpProxy`,
syncs profiles and caches (usage, models, reasoning) in parallel across all
healthy accounts, and runs one-shot failover via [`runner.ts`](./runner.ts).
[`acp-bin.ts`](./acp-bin.ts) is the ACP-only launcher (`ensureAgy` →
`runAcpProxy`). The proxy lives in [`acp/README.md`](./acp/README.md).
[`version.ts`](./version.ts) exports `VERSION`, inlined from `package.json` at
build time. Canonical domain terms are defined in [`../GLOSSARY.md`](../GLOSSARY.md).

## Interface

Named entry points and exported symbols; private helper inventory is omitted.
`index.ts` and `acp-bin.ts` are scripts.

| Group | Modules and exact symbols |
| --- | --- |
| Entry scripts | [`index.ts`](./index.ts) (`main`/`HELP`, no exports); [`acp-bin.ts`](./acp-bin.ts) (no exports); [`version.ts`](./version.ts) `VERSION` |
| Vocabulary and substrate | [`types.ts`](./types.ts) `Profile`, `UsageSnapshot`, `ModelsSnapshot`, `WrapperState`, `RunOutcome`; [`paths.ts`](./paths.ts) `ROOT`, `STATE_PATH`, `ACP_SESSIONS_PATH`, `currentRoot`/`profilesDir`/`statePath`/`acpSessionsPath`, `profileDir`, `resolveAgyBin`, `DEFAULT_RESERVE_PCT`/`DEFAULT_SWITCH_DELAY_MS`/`USAGE_TTL_MS`/`MODELS_TTL_MS`/`PROBE_SPACING_MS`; [`fs-utils.ts`](./fs-utils.ts) `readJson`, `writeJsonAtomic`, `exists`, `isRecord`, `killProcessGroup`, `symlinkIfMissing`, `linkOrReplaceWithSymlink`, `run` |
| Profiles and HOME ownership | [`registry.ts`](./registry.ts) `ISOLATED_LINUX_DBUS_ADDRESS`, `profileHomeOf`, `profileEnvOf`, `loadProfile`/`saveProfile`/`listProfiles`/`removeProfile`; [`profile.ts`](./profile.ts) `addProfile`, `loginProfile`, `hasValidAuth`, `syncProfile`/`syncProfiles`, `disableProfile`/`enableProfile`, `T3_ACP_RULES`; [`conversation-store.ts`](./conversation-store.ts) `sharedConversationsRoot`, `linkSharedConversations` |
| Deep Pool, Catalog & Probes | [`account-pool.ts`](./account-pool.ts) `AccountPool`, `rankProfiles`, `reservableCatalogs`, `loadState`/`saveState`, `isBlocked`; [`model-catalog.ts`](./model-catalog.ts) `ModelCatalog`, `filterModelCatalog`, `fetchModels`, `parseModelsOutput`, `supportsModel`, `isModelKnownUnsupported`, `reservedProfilesFor`, `withoutUnsupportedModel`, `isPublicGeminiModel`; [`probe-sync.ts`](./probe-sync.ts) `ProbeSync` (`syncAll`/`usage`/`models`/`refreshUsage`/`refreshModels`/`refreshReasoning`/`drain`/`size`); [`usage.ts`](./usage.ts) `fetchUsage`, `parseUsageTable`, `familyForModel`, `blockingReset`, `summarizeMultiUsage`, `formatMultiUsageReport`; [`setup.ts`](./setup.ts) `ensureAgy` |
| Classification, runs, prompts | [`classify.ts`](./classify.ts) `classifyRun`, `classifyAcpError`, `isSessionLostError`, `isModelUnsupportedError`; [`runner.ts`](./runner.ts) `runTurn`, `runWithFailover`, `parseResult`, `RunFailure`; [`injection.ts`](./injection.ts) `listUserSkills`, `findSkill`, `buildSkillsBlock`, `buildInjectedPrompt`; [`analytics.ts`](./analytics.ts) `collectAllTurns`, `aggregateTokens`, `renderPeriodTable`, `renderStatsTable` |
| Update and release | [`update.ts`](./update.ts) `fetchLatestRelease`, `selectAsset`, `installLatestRelease`, `runUpdateCommand`; [`release-plan.ts`](./release-plan.ts) `deriveBump`, `deriveRangeBump`, `nextVersion`, `formatChangelogSectionBody`, `upsertChangelogSection` |

## Invariants

- **Managed vs adopted HOME.** `profileHomeOf` is `profile.home ?? profileHome(slug)`.
  Managed profiles are provisioned at `addProfile`, by `syncProfile`/`syncProfiles`
  (parallelized across managed profiles), and on ACP start. Adopted profiles
  (`profile add --home`) skip provisioning and are never deleted on `removeProfile`.
- **Parallel auto-sync, non-blocking ACP ranking.** `ProbeSync.syncAll` refreshes
  usage, models, and reasoning across all healthy profiles in parallel with
  in-flight deduplication and a single atomic disk write per probe. `AccountPool`
  ranking always reads cached snapshots and never blocks on a probe; ACP starts
  non-blocking background auto-sync on startup in default pool mode (skipped in
  `--sequential` mode).
- **Unified Account Pool policy.** `AccountPool` owns `state.json` blocks/pins/checkpoints,
  profile health flags (`bannedAt`, `authRequiredAt`, `lastGenerationOkAt`), and
  eligible-only catalog reservation (`reservableCatalogs`), keeping CLI `run` and
  ACP selection and outcome clearing consistent.
- **Public Gemini Model Catalog.** `ModelCatalog` owns memory+disk model caches,
  reasoning overlays (without clobbering native reasoning metadata), unsupported
  model eviction, and outbound Gemini-only filtering across `session/new`,
  `session/load`, `session/resume`, and `session/fork`.
- **Detached probe safety.** Quota/model probes spawn detached on non-Windows and
  `killProcessGroup` (`SIGKILL` to `-pid`) on timeout, abort, or interactive-OAuth
  fallback detection. Interactive login is always an explicit command.

## Verification

Run from the repository root:

```sh
bun run typecheck
bun test
bun run build
```
