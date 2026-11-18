import type { AcpProxyOptions } from "./server";
import { extractCompactionThresholdArg, extractFlagArg } from "./token-usage";

/**
 * Parses `agy-multi acp` / `agy-multi-acp` CLI flags into `AcpProxyOptions`.
 *
 * Account pool is always active; `--sequential` restricts execution to one
 * active account at a time.
 */
export function parseAcpProxyOptions(rawArgs: string[]): AcpProxyOptions {
	const clean = rawArgs.includes("--clean");
	const sequential = rawArgs.includes("--sequential");

	const withoutFlags = rawArgs.filter(
		(arg: string) =>
			arg !== "--" &&
			arg !== "--clean" &&
			arg !== "--allow-account-pool" &&
			arg !== "--sequential",
	);
	const { value: switchDelay, rest: pacedArgs } = extractFlagArg(withoutFlags, "--switch-delay");
	const { value: handoffContext, rest: replayArgs } = extractFlagArg(pacedArgs, "--handoff-context");
	const { threshold, remainingArgs } = extractCompactionThresholdArg(replayArgs);
	const extraArgs = clean
		? ["--include-default-customizations=false", "--disable-slash-commands", ...remainingArgs]
		: remainingArgs;
	const switchDelayMs = switchDelay === undefined ? undefined : Math.round(Number(switchDelay) * 1000);
	const handoffContextChars = handoffContext === undefined ? undefined : Number(handoffContext);

	return {
		compactionThreshold: threshold,
		extraArgs,
		sequential,
		...(switchDelayMs !== undefined && Number.isFinite(switchDelayMs) ? { switchDelayMs } : {}),
		...(handoffContextChars !== undefined && Number.isFinite(handoffContextChars) ? { handoffContextChars } : {}),
	};
}
