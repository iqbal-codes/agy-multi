import type { AcpProxyOptions } from "./server";

/** Pulls `--name <value>` / `--name=<value>` out of argv, leaving the rest intact. */
export function extractFlagArg(args: string[], name: string): { value?: string; rest: string[] } {
	const rest: string[] = [];
	let value: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === name) {
			value = args[++index];
			continue;
		}
		if (arg.startsWith(`${name}=`)) {
			value = arg.slice(name.length + 1);
			continue;
		}
		rest.push(arg);
	}
	return { value, rest };
}

/** Extracts `--compaction-threshold` from argv and returns remaining args. */
export function extractCompactionThresholdArg(args: string[]): {
	threshold?: number;
	remainingArgs: string[];
} {
	let threshold: number | undefined;
	const remainingArgs: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--compaction-threshold" && i + 1 < args.length) {
			const parsed = Number.parseInt(args[++i]!, 10);
			if (Number.isFinite(parsed) && parsed >= 0) threshold = parsed;
		} else if (arg.startsWith("--compaction-threshold=")) {
			const val = arg.slice("--compaction-threshold=".length);
			const parsed = Number.parseInt(val, 10);
			if (Number.isFinite(parsed) && parsed >= 0) threshold = parsed;
		} else {
			remainingArgs.push(arg);
		}
	}
	return { threshold, remainingArgs };
}

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
