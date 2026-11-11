#!/usr/bin/env bun
import { runAcpProxy } from "./acp/server";
import { ensureAgy } from "./setup";
import { extractCompactionThresholdArg } from "./acp/token-usage";

await ensureAgy({ autoInstall: true });
const rawArgs = Bun.argv.slice(2).filter((arg: string) => arg !== "--");
const { threshold, remainingArgs } = extractCompactionThresholdArg(rawArgs);
await runAcpProxy({ compactionThreshold: threshold, extraArgs: remainingArgs });
