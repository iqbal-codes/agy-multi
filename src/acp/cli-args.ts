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

/** Pulls all `--name <value>` / `--name=<value>` occurrences out of argv. */
export function extractAllFlagArgs(args: string[], name: string): { values: string[]; rest: string[] } {
	const rest: string[] = [];
	const values: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === name && index + 1 < args.length) {
			values.push(args[++index]!);
			continue;
		}
		if (arg.startsWith(`${name}=`)) {
			values.push(arg.slice(name.length + 1));
			continue;
		}
		rest.push(arg);
	}
	return { values, rest };
}

function hasCleanCustomizationFlag(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--clean" || arg === "--include-default-customizations=false") return true;
		if (arg === "--include-default-customizations" && args[i + 1] === "false") return true;
	}
	return false;
}

/**
 * Parses `agy-multi acp` / `agy-multi-acp` CLI flags into `AcpProxyOptions`.
 *
 * Account pool is always active; `--sequential` restricts execution to one
 * active account at a time.
 */
export function parseAcpProxyOptions(rawArgs: string[]): AcpProxyOptions {
	const clean = hasCleanCustomizationFlag(rawArgs);
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
	const { values: rawSkills, rest: skillFreeArgs } = extractAllFlagArgs(replayArgs, "--skills");
	const { threshold, remainingArgs } = extractCompactionThresholdArg(skillFreeArgs);

	const skills = rawSkills
		.flatMap(entry => entry.split(","))
		.map(entry => entry.trim())
		.filter(Boolean);

	const hasDefaultCustomizationsFlag = remainingArgs.some(
		(arg, i) =>
			arg.startsWith("--include-default-customizations=") ||
			(arg === "--include-default-customizations" && i + 1 < remainingArgs.length),
	);
	const extraArgs =
		clean && !hasDefaultCustomizationsFlag
			? ["--include-default-customizations=false", ...remainingArgs]
			: remainingArgs;
	const switchDelayMs = switchDelay === undefined ? undefined : Math.round(Number(switchDelay) * 1000);
	const handoffContextChars = handoffContext === undefined ? undefined : Number(handoffContext);

	return {
		...(clean ? { clean: true } : {}),
		...(skills.length > 0 ? { skills } : {}),
		compactionThreshold: threshold,
		extraArgs,
		sequential,
		...(switchDelayMs !== undefined && Number.isFinite(switchDelayMs) ? { switchDelayMs } : {}),
		...(handoffContextChars !== undefined && Number.isFinite(handoffContextChars) ? { handoffContextChars } : {}),
	};
}
