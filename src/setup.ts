import { homedir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline/promises";
import { resolveAgyBin, updateAgyBin } from "./paths";

export interface EnsureAgyOptions {
	interactive?: boolean;
	autoInstall?: boolean;
}

export async function ensureAgy(options?: EnsureAgyOptions): Promise<string> {
	let bin = resolveAgyBin();
	if (Bun.which(bin)) return bin;

	const isWindows = process.platform === "win32";
	const installCmd = isWindows
		? "irm https://antigravity.google/cli/install.ps1 | iex"
		: "curl -fsSL https://antigravity.google/cli/install.sh | bash";

	const isInteractive = options?.interactive ?? Boolean(process.stdout.isTTY && process.stdin.isTTY);
	const shouldAutoInstall = options?.autoInstall ?? false;

	if (!shouldAutoInstall && isInteractive) {
		process.stdout.write("\nOfficial Google Antigravity CLI ('agy') was not found.\n");
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		try {
			const answer = await rl.question("Would you like to download and install it now? [Y/n] ");
			if (answer.trim().toLowerCase().startsWith("n")) {
				throw new Error(
					`Official Antigravity CLI ('agy') is required.\nYou can install it manually by running:\n\n  ${installCmd}\n`
				);
			}
		} finally {
			rl.close();
		}
	} else if (!shouldAutoInstall && !isInteractive) {
		process.stderr.write(`[agy-multi] Official Antigravity CLI ('agy') not found. Installing via official installer...\n`);
	}

	process.stderr.write(`\n==> Downloading and installing official Antigravity CLI ('agy')...\n`);

	const installProc = isWindows
		? Bun.spawn(["powershell", "-ExecutionPolicy", "Bypass", "-Command", installCmd], {
				stdout: "inherit",
				stderr: "inherit",
		  })
		: Bun.spawn(["bash", "-c", installCmd], {
				stdout: "inherit",
				stderr: "inherit",
		  });

	const code = await installProc.exited;
	if (code !== 0) {
		throw new Error(
			`Failed to install official Antigravity CLI (exit code ${code}).\nPlease install it manually by running:\n\n  ${installCmd}\n`
		);
	}

	// Update PATH dynamically for current process
	const localBin = isWindows
		? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "agy", "bin")
		: join(homedir(), ".local", "bin");

	if (!process.env.PATH?.includes(localBin)) {
		process.env.PATH = `${localBin}${isWindows ? ";" : ":"}${process.env.PATH ?? ""}`;
	}

	bin = updateAgyBin();
	if (!Bun.which(bin)) {
		const directPath = join(localBin, isWindows ? "agy.exe" : "agy");
		if (Bun.which(directPath)) {
			process.env.AGY_BIN = directPath;
			bin = updateAgyBin();
		} else {
			throw new Error(
				`Antigravity CLI was installed to ${localBin}, but not found in PATH.\nPlease restart your terminal or add ${localBin} to PATH.`
			);
		}
	}

	process.stderr.write(`==> Official Antigravity CLI ('agy') installed and verified successfully!\n\n`);
	return bin;
}
