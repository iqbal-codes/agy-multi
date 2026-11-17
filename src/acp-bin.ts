#!/usr/bin/env bun
import { runAcpProxy } from "./acp/server";
import { ensureAgy } from "./setup";
import { extractCompactionThresholdArg, extractFlagArg } from "./acp/token-usage";

await ensureAgy({ autoInstall: true });
const rawArgs = Bun.argv.slice(2).filter((arg: string) => arg !== "--");
const clean = rawArgs.includes("--clean");
const allowAccountPool = rawArgs.includes("--allow-account-pool");
const sequential = rawArgs.includes("--sequential");
const withoutFlags = rawArgs.filter(
	(arg: string) => arg !== "--clean" && arg !== "--allow-account-pool" && arg !== "--sequential",
);
const { value: profile, rest: profiledArgs } = extractFlagArg(withoutFlags, "--profile");
const { value: switchDelay, rest: pacedArgs } = extractFlagArg(profiledArgs, "--switch-delay");
const { value: handoffContext, rest: replayArgs } = extractFlagArg(pacedArgs, "--handoff-context");
const { threshold, remainingArgs } = extractCompactionThresholdArg(replayArgs);
const extraArgs = clean
	? ["--include-default-customizations=false", "--disable-slash-commands", ...remainingArgs]
	: remainingArgs;
const switchDelayMs = switchDelay === undefined ? undefined : Math.round(Number(switchDelay) * 1000);
const handoffContextChars = handoffContext === undefined ? undefined : Number(handoffContext);
await runAcpProxy({
	compactionThreshold: threshold,
	extraArgs,
	allowAccountPool,
	sequential,
	...(profile ? { profile } : {}),
	...(switchDelayMs !== undefined && Number.isFinite(switchDelayMs) ? { switchDelayMs } : {}),
	...(handoffContextChars !== undefined && Number.isFinite(handoffContextChars) ? { handoffContextChars } : {}),
});
