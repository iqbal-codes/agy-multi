import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

export interface HarnessConfig {
  static?: string;
  unit?: string;
  unit_count_pattern?: string;
  required_checks?: string;
  protected_paths?: string;
}

export function runChecks(repoRoot: string): { success: boolean; output: string } {
  const configPath = join(repoRoot, "harness/harness.config.json");
  if (!existsSync(configPath)) {
    throw new Error("harness.config.json not found");
  }
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as HarnessConfig;
  const logs: string[] = ["HARNESS_START mode=ordinary"];

  if (config.static && config.static !== "true") {
    const res = spawnSync(config.static, { cwd: repoRoot, shell: true, encoding: "utf-8" });
    if (res.status !== 0) {
      logs.push(res.stdout || "", res.stderr || "", "GATE_FAILED: static");
      return { success: false, output: logs.join("
") };
    }
    logs.push("STATIC_OK");
  }

  if (config.unit && config.unit !== "true") {
    const res = spawnSync(config.unit, { cwd: repoRoot, shell: true, encoding: "utf-8" });
    if (res.status !== 0) {
      logs.push(res.stdout || "", res.stderr || "", "GATE_FAILED: unit");
      return { success: false, output: logs.join("
") };
    }
    logs.push("UNIT_PASSED");
  }

  logs.push("CHECKS_OK mode=ordinary");
  return { success: true, output: logs.join("
") };
}

if (import.meta.main || process.argv[1]?.endsWith("ci.ts")) {
  const res = runChecks(process.cwd());
  console.log(res.output);
  process.exit(res.success ? 0 : 1);
}
