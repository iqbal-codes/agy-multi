/**
 * Pi Extension Hook (-e .factory/hooks/loop-guard.ts)
 * Acts inside the tool execution loop (Harness² c8 component) across any stack
 * (Backend, Frontend, Full-Stack, Mobile, Database, CLI) to enforce:
 * 1. Protected path invariants
 * 2. Codebase convention rules (.factory/codebase-rules.json) — warn by default, block for strict invariants
 * 3. Shared pattern/module registry hints (.factory/codebase-rules.json)
 * 4. Active repository lessons (.factory/lessons.jsonl) matching the target file
 * 5. Verified CLI guidance hints on bash tool failures (.factory/tool-guidance.json)
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const READ_ONLY_TRIAGE_TOOLS = new Set([
  "read",
  "read_file",
  "list_dir",
  "readdir",
  "ls",
  "search",
  "grep",
  "find",
  "glob",
]);

type TriagePolicy = (
  toolName: string,
  input?: Record<string, any>,
) => { allowed: boolean; reason?: string };

let triagePolicyPromise: Promise<TriagePolicy | null> | undefined;

async function resolveTriagePolicy(): Promise<TriagePolicy | null> {
  if (triagePolicyPromise === undefined) {
    triagePolicyPromise = import("../../scripts/loop/triage-policy")
      .then((mod) =>
        typeof mod.evaluateTriageToolCall === "function"
          ? (mod.evaluateTriageToolCall as TriagePolicy)
          : null,
      )
      .catch(() => null);
  }
  return triagePolicyPromise;
}

export interface CodebaseRule {
  id: string;
  description: string;
  file_glob: string;
  forbid_regex?: string;
  require_regex?: string;
  replacement_hint: string;
  mode?: "block" | "warn";
}

export interface PatternRegistryEntry {
  guidance: string;
  file_glob?: string;
}

export interface CodebaseRulesConfig {
  schema_version?: number;
  description?: string;
  rules?: CodebaseRule[];
  pattern_registry?: Record<string, string | PatternRegistryEntry>;
  /** Alias for backwards compatibility */
  component_registry?: Record<string, string | PatternRegistryEntry>;
}

const DEFAULT_PROTECTED_PATTERNS = [
  /^\.animus\/holdout(\/|$)/,
  /^\.animus\/hooks(\/|$)/,
  /^\.factory\/holdout(\/|$)/,
  /^\.factory\/hooks(\/|$)/,
  /^\.claude\/settings(?:\.local)?\.json$/,
  /^\.ignore$/,
  /^harness(\/|$)/,
];

const SOURCE_FILE_REGEX =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|dart|rb|php|cs|c|cpp|h|sql|prisma|graphql|proto|sh)$/i;

function globMatchesPath(globPattern: string, targetPath: string): boolean {
  const normPath = targetPath.replace(/\\/g, "/").replace(/^\.\//, "");
  try {
    if (typeof (globalThis as any).Bun?.Glob === "function") {
      if (new (globalThis as any).Bun.Glob(globPattern).match(normPath)) return true;
    }
  } catch {}
  try {
    const rxStr =
      "^" +
      globPattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, ".*")
        .replace(/(?<!\.)\*/g, "[^/]*") +
      "$";
    if (new RegExp(rxStr, "i").test(normPath)) return true;
  } catch {}
  const cleanToken = globPattern.replace(/\*+/g, "").toLowerCase();
  return cleanToken.length >= 3 && normPath.toLowerCase().includes(cleanToken);
}

export function isProtectedPath(targetPath: string, cwd: string = process.cwd()): boolean {
  if (!targetPath || typeof targetPath !== "string") return false;
  const rawClean = targetPath.trim().replace(/^["']|["']$/g, "");
  const norm = isAbsolute(rawClean) ? relative(cwd, rawClean) : rawClean;
  const normalized = norm.replace(/\\/g, "/").replace(/^\.\//, "");
  if (DEFAULT_PROTECTED_PATTERNS.some((rx) => rx.test(normalized))) return true;

  const configPath = join(cwd, "harness/harness.config.json");
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      const rawPaths = cfg?.protected_paths;
      if (typeof rawPaths === "string" && rawPaths.trim()) {
        const globs = rawPaths.split(",").map((s: string) => s.trim()).filter(Boolean);
        for (const g of globs) {
          if (globMatchesPath(g, normalized)) return true;
        }
      }
    } catch {}
  }
  return false;
}

export function loadCodebaseRules(cwd: string): CodebaseRulesConfig {
  const primaryPath = join(cwd, ".animus/codebase-rules.json");
  const fallbackPath = join(cwd, ".factory/codebase-rules.json");
  const p = existsSync(primaryPath) ? primaryPath : fallbackPath;
  if (!existsSync(p)) return { rules: [] };
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as CodebaseRulesConfig;
  } catch {
    return { rules: [] };
  }
}

export function evaluateCodebaseRulesOnEdit(
  cwd: string,
  relPath: string,
  newContent: string,
): { blocked: boolean; reasons: string[]; warnings: string[]; registryHints: string[] } {
  const cfg = loadCodebaseRules(cwd);
  const rules = cfg.rules ?? [];
  const reasons: string[] = [];
  const warnings: string[] = [];
  const registryHints: string[] = [];

  for (const rule of rules) {
    if (!globMatchesPath(rule.file_glob, relPath)) continue;

    let violated = false;
    if (rule.forbid_regex) {
      try {
        const rx = new RegExp(rule.forbid_regex, "m");
        if (rx.test(newContent)) violated = true;
      } catch {}
    }
    if (!violated && rule.require_regex) {
      try {
        const rx = new RegExp(rule.require_regex, "m");
        if (!rx.test(newContent)) violated = true;
      } catch {}
    }

    if (violated) {
      const msg = `[${rule.id}] ${rule.description} — ${rule.replacement_hint}`;
      if (rule.mode === "block") {
        reasons.push(msg);
      } else {
        warnings.push(msg);
      }
    }
  }

  const combinedRegistry = {
    ...(cfg.component_registry ?? {}),
    ...(cfg.pattern_registry ?? {}),
  };

  if (Object.keys(combinedRegistry).length > 0 && SOURCE_FILE_REGEX.test(relPath)) {
    for (const [domain, entry] of Object.entries(combinedRegistry)) {
      if (typeof entry === "string") {
        registryHints.push(`[${domain}] ${entry}`);
      } else if (entry && typeof entry === "object" && typeof entry.guidance === "string") {
        if (!entry.file_glob || globMatchesPath(entry.file_glob, relPath)) {
          registryHints.push(`[${domain}] ${entry.guidance}`);
        }
      }
    }
  }

  return {
    blocked: reasons.length > 0,
    reasons,
    warnings,
    registryHints,
  };
}

function loadMatchingLessonsForFile(cwd: string, relPath: string): string[] {
  const primaryPath = join(cwd, ".animus/lessons.jsonl");
  const fallbackPath = join(cwd, ".factory/lessons.jsonl");
  const p = existsSync(primaryPath) ? primaryPath : fallbackPath;
  if (!existsSync(p)) return [];
  const matches: string[] = [];
  try {
    const lines = readFileSync(p, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry && !entry.vetoed && Array.isArray(entry.trigger_patterns)) {
        if (entry.trigger_patterns.some((pat: string) => globMatchesPath(pat, relPath))) {
          matches.push(`[${entry.topic}] ${entry.rule}`);
        }
      }
    }
  } catch {}
  return matches.slice(0, 3);
}

function loadToolGuidance(cwd: string): Record<string, string> {
  const primaryPath = join(cwd, ".animus/tool-guidance.json");
  const fallbackPath = join(cwd, ".factory/tool-guidance.json");
  const p = existsSync(primaryPath) ? primaryPath : fallbackPath;
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

export default function registerLoopGuard(api: any) {
  if (!api || typeof api.on !== "function") return;

  let consecutiveBashFailures = 0;
  const surfacedRegistryHints = new Set<string>();
  const surfacedLessonHints = new Set<string>();

  api.on("tool_call", async (event: any) => {
    const toolName = String(event?.toolName ?? "");
    const args = (event?.input ?? event?.args ?? {}) as Record<string, any>;

    if (process.env.FACTORY_LOOP_ROLE === "triage") {
      const evaluateTriageToolCall = await resolveTriagePolicy();
      const triageCheck = evaluateTriageToolCall
        ? evaluateTriageToolCall(toolName, args)
        : READ_ONLY_TRIAGE_TOOLS.has(toolName)
          ? { allowed: true }
          : {
              allowed: false,
              reason: `TRIAGE GUARD: Tool '${toolName}' is forbidden during triage passes. Only read-only inspection tools are permitted.`,
            };
      if (!triageCheck.allowed) {
        return {
          block: true,
          reason: triageCheck.reason ?? "TRIAGE GUARD: Operation forbidden during triage passes.",
        };
      }
    }

    const now = Date.now();
    const hardDeadline = Number(process.env.FACTORY_LOOP_HARD_DEADLINE_MS);
    const softDeadline = Number(process.env.FACTORY_LOOP_SOFT_DEADLINE_MS);
    if (Number.isFinite(hardDeadline) && hardDeadline > 0 && now >= hardDeadline) {
      return {
        block: true,
        reason:
          "HARD DEADLINE: stop tools and report interrupted; the host preserves this attempt.",
      };
    }
    const normTool = toolName.toLowerCase().trim();
    if (Number.isFinite(softDeadline) && softDeadline > 0 && now >= softDeadline) {
      const checkpoint = process.env.FACTORY_LOOP_CHECKPOINT_PATH;
      const targetPathForSoft = typeof args.path === "string" ? args.path : typeof args.Path === "string" ? args.Path : "";
      const checkpointWrite =
        (normTool === "write" || normTool === "edit") &&
        checkpoint &&
        targetPathForSoft &&
        resolve(targetPathForSoft) === resolve(checkpoint);
      // Deliberately allow only simple read-only git commands, not arbitrary shell syntax.
      const gitInspection =
        normTool === "bash" &&
        typeof args.command === "string" &&
        /^git (?:status(?: --short)?|diff(?: --stat| --name-only)?|rev-parse HEAD)$/.test(
          args.command.trim(),
        );
      if (!checkpointWrite && !gitInspection) {
        return {
          block: true,
          reason: `SOFT DEADLINE: stop new work, write progress, checks, blockers and next steps to ${checkpoint ?? "the checkpoint path in your prompt"}, then report {"verdict":"interrupted"}. Do not claim pass.`,
        };
      }
    }
    if (normTool === "bash") {
      if (typeof args.command === "string") {
        const cmd = args.command;
        if (
          /(?:^|[;&|\n]\s*)\bgit\s+(?:[^;&|\n]*?\s+)?(?:commit|push|merge)\s+[^;&|\n]*?(?:--no-verify|-n\b)/i.test(cmd) ||
          /(?:^|[;&|\n]\s*)\bgit\s+[^;&|\n]*?(?:--no-verify|-n\b)[^;&|\n]*?\s+(?:commit|push|merge)\b/i.test(cmd) ||
          /\bgit\b.*-c\s+core\.hooksPath=(?:\/dev\/null|""|'')/i.test(cmd)
        ) {
          return {
            block: true,
            reason:
              "HARNESS GUARD: Bypassing git hooks with --no-verify, -n, or overriding core.hooksPath is strictly prohibited. All commits must pass deterministic pre-commit CI gates.",
          };
        }

        const hasMutation =
          /(?:>|>>|\btee\b|\b(?:sed|perl)\s+-[a-zA-Z]*i|\b(?:rm|mv|cp|chmod|truncate|ln|install)\b|\bgit\s+(?:checkout|restore|rm|mv|reset|stash)\b)/i.test(
            cmd,
          );
        if (hasMutation) {
          const protectedTokens = [
            ".animus/holdout",
            ".animus/hooks",
            ".factory/holdout",
            ".factory/hooks",
            ".claude/settings",
            "harness/",
            ".ignore",
          ];
          for (const tok of protectedTokens) {
            if (cmd.includes(tok)) {
              return {
                block: true,
                reason: `HARNESS GUARD: Modifying protected path '${tok}' via shell command is forbidden.`,
              };
            }
          }
        }
      }

      const requested =
        typeof args.timeout === "number" && Number.isFinite(args.timeout) && args.timeout > 0
          ? args.timeout
          : 90;
      args.timeout =
        Number.isFinite(hardDeadline) && hardDeadline > 0
          ? Math.min(requested, Math.max(0.001, (hardDeadline - now) / 1000))
          : requested;
    }

    const isWriteTool =
      normTool === "write" ||
      normTool === "edit" ||
      normTool === "write_file" ||
      normTool === "edit_file" ||
      normTool === "multiedit" ||
      normTool === "strreplace" ||
      normTool === "str_replace_editor";

    const targetPath =
      typeof args.path === "string"
        ? args.path
        : typeof args.Path === "string"
          ? args.Path
          : typeof args.file_path === "string"
            ? args.file_path
            : typeof args.filePath === "string"
              ? args.filePath
              : typeof args.target_file === "string"
                ? args.target_file
                : typeof args.file === "string"
                  ? args.file
                  : null;

    if (isWriteTool && targetPath) {
      if (isProtectedPath(targetPath, process.cwd())) {
        return {
          block: true,
          reason: `HARNESS GUARD: Modifying protected path '${targetPath}' inside a delivery lap is forbidden.`,
        };
      }

      const candidateText =
        typeof args.content === "string"
          ? args.content
          : typeof args.Content === "string"
            ? args.Content
            : typeof args.new_string === "string"
              ? args.new_string
              : typeof args.Replacement === "string"
                ? args.Replacement
                : Array.isArray(args.edits)
                  ? args.edits.map((e: any) => e?.newText ?? "").join("\n")
                  : "";

      if (candidateText) {
        const evalRes = evaluateCodebaseRulesOnEdit(process.cwd(), targetPath, candidateText);
        if (evalRes.blocked) {
          return {
            block: true,
            reason: `CODEBASE STANDARD VIOLATION in '${targetPath}':\n${evalRes.reasons.map((r) => `  - ${r}`).join("\n")}`,
          };
        }
      }
    }
    return undefined;
  });

  api.on("tool_result", async (event: any) => {
    const toolName = String(event?.toolName ?? "");
    const args = event?.input ?? event?.args ?? {};

    if (toolName === "bash" && !event?.isError) {
      consecutiveBashFailures = 0;
    }

    if (toolName === "bash" && event?.isError) {
      consecutiveBashFailures += 1;
      const guidance = loadToolGuidance(process.cwd());
      const entries = Object.entries(guidance);
      const hints: string[] = [];
      if (entries.length > 0) {
        const hint = entries.map(([k, v]) => `${k}: \`${v}\``).join(", ");
        hints.push(`[HARNESS TOOL GUIDANCE HINT] Verified repository commands -> ${hint}`);
      }
      if (consecutiveBashFailures >= 2) {
        hints.push(
          "[HARNESS UNSTICK TRIGGER — 2+ CONSECUTIVE FAILURES]: Stop editing production code immediately. Follow .agents/skills/unstick/SKILL.md: (1) state the single shared assumption behind the failed attempts in one sentence, (2) run a 1-line probe to test that assumption directly, (3) revert broken scratch edits (`git checkout -- <files>`) before trying an orthogonal approach, and (4) log the disproved assumption in your checkpoint.",
        );
      }
      const rawText = Array.isArray(event?.content)
        ? event.content.map((c: any) => c?.text ?? "").join("\n")
        : String(event?.content ?? "");
      if (
        rawText.toLowerCase().includes("timed out") ||
        rawText.toLowerCase().includes("timeout")
      ) {
        hints.push(
          "[HARNESS TIMEOUT HINT] Command exceeded timeout budget. Avoid long-running background tasks without explicit timeouts, and avoid reading daemon process streams before process termination.",
        );
      }
      if (hints.length > 0) {
        return {
          content: [...(event.content ?? []), { type: "text", text: `\n${hints.join("\n")}` }],
        };
      }
    }

    if (
      (toolName === "read" || toolName === "write" || toolName === "edit") &&
      typeof args.path === "string"
    ) {
      const lessons = loadMatchingLessonsForFile(process.cwd(), args.path);
      const candidateText =
        typeof args.content === "string"
          ? args.content
          : Array.isArray(args.edits)
            ? args.edits.map((e: any) => e?.newText ?? "").join("\n")
            : "";
      const ruleEval = evaluateCodebaseRulesOnEdit(process.cwd(), args.path, candidateText);

      const sections: string[] = [];
      if (ruleEval.warnings.length > 0) {
        sections.push(
          `[CODEBASE PATTERN REMINDER for ${args.path}]:\n${ruleEval.warnings.map((w) => `  - ${w}`).join("\n")}`,
        );
      }
      if (toolName === "read" && ruleEval.registryHints.length > 0) {
        const freshRegistry = ruleEval.registryHints.filter((h) => !surfacedRegistryHints.has(h));
        for (const h of freshRegistry) surfacedRegistryHints.add(h);
        if (freshRegistry.length > 0) {
          sections.push(
            `[SHARED PATTERN & MODULE REGISTRY]:\n${freshRegistry.map((h) => `  - ${h}`).join("\n")}`,
          );
        }
      }
      if (lessons.length > 0) {
        const freshLessons = lessons.filter((l) => !surfacedLessonHints.has(l));
        for (const l of freshLessons) surfacedLessonHints.add(l);
        if (freshLessons.length > 0) {
          sections.push(
            `[HARNESS ACTIVE LESSONS for ${args.path}]:\n${freshLessons.map((l) => `  - ${l}`).join("\n")}`,
          );
        }
      }
      if ((toolName === "write" || toolName === "edit") && consecutiveBashFailures >= 2) {
        sections.push(
          "[HARNESS UNSTICK WARNING]: You modified code after 2+ consecutive command failures without a passing probe. Follow .agents/skills/unstick/SKILL.md: verify your shared assumption with a 1-line probe and revert broken scratch edits if the next check fails.",
        );
      }
      if (sections.length > 0) {
        return {
          content: [...(event.content ?? []), { type: "text", text: `\n${sections.join("\n")}` }],
        };
      }
    }

    return undefined;
  });
}

// CLI / git hook execution support
if (import.meta.main) {
  const args = process.argv.slice(2);
  const cwd = process.cwd();

  // If invoked with --pre-commit or list of files
  let filesToCheck: string[] = [];
  if (args.includes("--pre-commit")) {
    try {
      const proc = Bun.spawnSync(["git", "diff", "--cached", "--name-only"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = proc.stdout.toString();
      filesToCheck = stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      filesToCheck = [];
    }
  } else {
    filesToCheck = args.filter((a) => !a.startsWith("-"));
  }

  let hasFatalError = false;
  for (const file of filesToCheck) {
    if (isProtectedPath(file)) {
      console.error(
        `\x1b[31m[HARNESS GUARD ERROR]\x1b[0m Modifying protected path '${file}' is forbidden during delivery laps.`,
      );
      hasFatalError = true;
    }
  }

  if (hasFatalError) {
    process.exit(1);
  }
}
