/**
 * `duskfleet init`: the guided first setup. Each step prints its result; a config that cannot be
 * written or loaded stops with the fix (exit 1):
 *
 *   1. Node: the version (the >= 24 check already ran in cli.ts, before this code loaded).
 *   2. Agent CLIs (#489): one line per shipped harness (Claude Code, GitHub Copilot CLI, Codex
 *      CLI), found or not, version, login where a verified command exists (`agent-clis.ts`).
 *      Satisfied by any one usable CLI; the missing ones are optional. Not blocking (#349):
 *      without a usable CLI init goes on, repeats the fix after the summary and exits 0.
 *   3. Config and data: the user-level directories with the starter duskfleet.yaml
 *      (`initUserConfig`); an existing config is reported and left untouched.
 *   4. MCP registration, optional: asked on a terminal; under --yes only with --mcp <target>.
 *      Then, on a terminal only and never under --yes, the optional guided first run
 *      (`first-run.ts`: a read-only `first-run` agent on one of the usable CLIs, cost stated
 *      before asking).
 *   5. What was created, where, and the next commands.
 *
 * Duskfleet ships no agent (owner decision 2026-10-26): the next commands start with
 * `agents create`. No prompt library: `node:readline/promises`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { type ConfigLocation, initUserConfig, loadConfig, locateConfig } from "@duskfleet/core";
import { type AgentCli, type CliSettings, detectAgentClis } from "./agent-clis.js";
import { MCP_TARGETS, type McpTarget } from "./mcp-register.js";

export interface InitOptions {
  /** No prompts: steps 1-3 and the summary; MCP registration only with `mcp`. */
  yes: boolean;
  /** `--mcp <target>`: register without asking. */
  mcp: McpTarget | null;
  /** `--harness <name>`: the guided first run's CLI, without asking. */
  harness?: string | null;
  /** Where the CLI runs from (locates a repo-local config like every other command). */
  entryFileUrl: string;
  /** Step 4, run once the config exists; returns the exit code of `mcp register`. */
  registerMcp(target: McpTarget): Promise<number>;
  /**
   * The optional guided first run after step 4 (`first-run.ts`, the same code as `run --first`):
   * asks before spending anything; returns its exit code. Only on a terminal, never under --yes.
   * `usable` = the harnesses step 2 found usable, in their order.
   */
  firstRun(usable: string[]): Promise<number>;
}

const out = (s: string) => process.stdout.write(`${s}\n`);
const fail = (s: string) => process.stderr.write(`${s}\n`);

/** The binaries and env_passthrough of an existing config, so a second init sees what runs see. */
function existingSettings(location: ConfigLocation): CliSettings {
  const none: CliSettings = { claudeBinary: null, copilotBinary: null, codexBinary: null, envPassthrough: [] };
  if (!existsSync(path.join(location.configDir, "duskfleet.yaml"))) return none;
  try {
    const config = loadConfig(location.configDir);
    return {
      claudeBinary: config.claude.binary,
      copilotBinary: config.copilot?.binary ?? null,
      codexBinary: config.codex?.binary ?? null,
      envPassthrough: config.claude.envPassthrough,
    };
  } catch {
    return none; // step 3 reports the config; doctor explains a broken one
  }
}

/** The answers `askMcpTarget` takes for each host, besides its name. */
const MCP_TARGET_ALIASES: Readonly<Record<McpTarget, readonly string[]>> = {
  "claude-code": ["code", "claude code", "c"],
  "claude-desktop": ["desktop", "claude desktop", "d"],
};

/** An answer to the MCP question: a host `mcp register` supports, or null (skip). */
export function parseMcpAnswer(answer: string): McpTarget | null {
  const a = answer.trim().toLowerCase();
  return MCP_TARGETS.find((t) => t === a || MCP_TARGET_ALIASES[t].includes(a)) ?? null;
}

async function askMcpTarget(): Promise<McpTarget | null> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return parseMcpAnswer(await rl.question(`Register the MCP server? [${[...MCP_TARGETS, "skip"].join("/")}] `));
  } finally {
    rl.close();
  }
}

/**
 * Step 2 as printed: a header (stdout when one CLI is usable, else stderr) and one line per CLI
 * (stderr for a CLI found but not usable, stdout otherwise).
 */
export function agentClisReport(clis: readonly AgentCli[]): { stream: "out" | "err"; text: string }[] {
  const usable = clis.filter((c) => c.usable);
  const lines: { stream: "out" | "err"; text: string }[] = [
    usable.length > 0
      ? { stream: "out", text: `[2/5] Agent CLIs: ${usable.map((c) => c.label).join(", ")} usable` }
      : { stream: "err", text: "[2/5] Agent CLIs: none usable" },
  ];
  for (const c of clis) lines.push({ stream: c.binary && !c.usable ? "err" : "out", text: `      ${c.line}` });
  return lines;
}

/**
 * What to repeat after the summary: the fix of each CLI found but not usable, then either the
 * optional ones that are missing (one usable CLI is enough) or, with none usable, how to get one.
 */
export function agentClisAdvice(clis: readonly AgentCli[]): string[] {
  const usable = clis.some((c) => c.usable);
  const missing = clis.filter((c) => !c.binary);
  const lines = clis.flatMap((c) => (c.fix ? [c.fix] : []));
  if (usable) {
    if (missing.length > 0) {
      lines.push(
        `Optional, not installed: ${missing.map((c) => `${c.label} (harness: ${c.harness})`).join(", ")}. One agent CLI is enough; install another to run agents on it too.`,
      );
    }
    return lines;
  }
  if (missing.length > 0) {
    lines.push(
      `No agent CLI is installed: install one of ${missing.map((c) => c.label).join(", ")} (any one is enough; Claude Code: https://docs.claude.com/en/docs/claude-code), log in, then check it with: duskfleet doctor --probe`,
    );
  }
  lines.push(
    "Until then the config, the read-only commands, agents create and the dashboard work; run, serve and schedules need a usable agent CLI.",
  );
  return lines;
}

/** The guided first run spends money or plan usage: offered on a terminal only, never under --yes. */
export function offersFirstRun(yes: boolean, isTTY: boolean): boolean {
  return !yes && isTTY;
}

/**
 * Runs the setup; returns the exit code (0, or 1 when the config cannot be written or loaded).
 * No usable agent CLI is not a failure: the hint is printed and the exit is 0.
 */
export async function runInit(options: InitOptions): Promise<number> {
  if (options.mcp && !MCP_TARGETS.includes(options.mcp)) {
    fail(`--mcp must be ${MCP_TARGETS.join(" or ")}`);
    return 2;
  }
  const location = locateConfig(options.entryFileUrl);
  const created: string[] = [];

  // 1. Node
  out(`[1/5] Node ${process.version}: ok`);

  // 2. Agent CLIs: same lookup and environment allow-list as the executors. Not blocking (owner
  // decision 2026-11-02, #349): the config, the read-only commands and the dashboard need no
  // login, only runs do. A problem here is printed now and repeated after the summary.
  const clis = await detectAgentClis(existingSettings(location));
  for (const line of agentClisReport(clis)) (line.stream === "out" ? out : fail)(line.text);
  const usable = clis.filter((c) => c.usable).map((c) => c.harness);

  // 3. Config and data
  const yamlPath = path.join(location.configDir, "duskfleet.yaml");
  if (existsSync(yamlPath)) {
    out(`[3/5] Config: ${yamlPath} already exists (${location.source}); left as it is`);
  } else if (location.source === "user") {
    const result = initUserConfig();
    created.push(...result.created);
    out(`[3/5] Config: created ${yamlPath}\n      Data directory: ${result.dataDir}`);
  } else {
    fail(`[3/5] Config: DUSKFLEET_CONFIG points to ${location.configDir}, which has no duskfleet.yaml`);
    fail("Unset DUSKFLEET_CONFIG to use the user-level directory, or point it at an existing config.");
    return 1;
  }
  try {
    loadConfig(location.configDir);
  } catch (err) {
    fail(`[3/5] Config: ${yamlPath} does not load: ${err instanceof Error ? err.message : String(err)}`);
    fail("Fix the file (duskfleet doctor shows the details), then run init again.");
    return 1;
  }

  // 4. MCP registration (optional): the hosts `mcp register` supports.
  const hosts = MCP_TARGETS.join("|");
  let target = options.mcp;
  if (!target && !options.yes) {
    if (process.stdin.isTTY) target = await askMcpTarget();
    else out(`[4/5] MCP registration: skipped (not a terminal; pass --mcp ${hosts})`);
  }
  // A failed registration does not stop init (#349, #490): the config is written, so init goes on
  // to the first run and the summary, repeats the failure after it and exits 1 so a script sees it.
  // A throw (bootstrap finds no agent CLI at all) is a failure like a non-zero exit.
  let mcpFailure: string | null = null;
  if (target) {
    out(`[4/5] MCP registration: ${target}`);
    let reason: string | null;
    try {
      const code = await options.registerMcp(target);
      reason = code === 0 ? null : `exit ${code}`;
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
    if (reason !== null) {
      mcpFailure = `MCP registration failed (${reason}); run it again with: duskfleet mcp register --target ${target}`;
      fail(`[4/5] ${mcpFailure}`);
    }
  } else if (options.yes || process.stdin.isTTY) {
    out(`[4/5] MCP registration: skipped (later: duskfleet mcp register --target ${hosts})`);
  }

  // Guided first run (optional, interactive only): asks first, says what it costs. A refused
  // path or a failed run is reported by the step itself and does not undo the setup above.
  // Not offered when step 2 found no usable agent CLI: the run would only fail (#349).
  if (offersFirstRun(options.yes, process.stdin.isTTY === true) && usable.length === 0) {
    out("Guided first run: skipped until an agent CLI is usable (then: duskfleet run --first)");
  } else if (offersFirstRun(options.yes, process.stdin.isTTY === true)) {
    try {
      await options.firstRun(usable);
    } catch (err) {
      fail(`First run: ${err instanceof Error ? err.message : String(err)} (try again: duskfleet run --first)`);
    }
  }

  // 5. Summary and next commands
  out(`[5/5] Done. ${created.length ? `Created: ${created.join(", ")}` : "Nothing was created."}`);
  const onOther = usable.length > 0 && !usable.includes("claude") ? ` --harness ${usable[0]}` : "";
  out(
    [
      "",
      "Next:",
      "  duskfleet doctor",
      onOther
        ? `  duskfleet agents create fixer${onOther} -- "You fix failing tests. Run the tests, fix the code, run them again."`
        : '  duskfleet agents create fixer --model haiku -- "You fix failing tests. Run the tests, fix the code, run them again."',
      '  duskfleet run --project <path> --agent fixer -- "Make the tests pass"',
    ].join("\n"),
  );
  const advice = agentClisAdvice(clis);
  // stdout like the summary, so a reader of `init` output alone sees why `run` would fail.
  if (advice.length > 0) out(`\n${advice.join("\n")}`);
  if (mcpFailure) {
    fail(`\n${mcpFailure}`);
    return 1;
  }
  return 0;
}
