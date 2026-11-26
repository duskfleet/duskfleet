/**
 * The guided first run (#204): the optional last step of an interactive `init`, and
 * `duskfleet run --first` to repeat it later (same code). It registers a project of the user's
 * in the private registry, creates the read-only `first-run` agent through the one agent-create
 * path in core (an existing one is reused only when it is still read-only and cheap), runs it
 * once with haiku, prints what the run did and cost, and offers to delete the agent again when
 * this step created it (the run row keeps its agent id either way).
 *
 * Duskfleet ships no agent (owner decision 2026-10-26): this step creates its own, named one,
 * so no agent-less run mode exists. Answers are read line by line from stdin (a terminal, or a
 * pipe in tests); end of input takes each question's default.
 */
import { createInterface } from "node:readline";
import {
  type AgentDefinition,
  CODEX_HARNESS,
  COPILOT_HARNESS,
  CURSOR_HARNESS,
  createAgentFromFields,
  DEFAULT_HARNESS,
  type DuskFleetConfig,
  deleteAgentFile,
  expandHome,
  harnessOf,
  ProjectValidationError,
  projectIdFromPath,
  REVIEW_REASON_LABELS,
  type Run,
  runCostLabel,
  SHIPPED_HARNESSES,
  sameDirectory,
  upsertUserProject,
  validateProjectPath,
} from "@duskfleet/core";
import { type AgentCli, defaultHarness, detectAgentClis, harnessLabel } from "./agent-clis.js";
import type { App } from "./bootstrap.js";

export const FIRST_RUN_AGENT_ID = "first-run";
export const FIRST_RUN_MODEL = "haiku";
export const FIRST_RUN_PROMPT = "Describe this project in three sentences. Do not change any file.";
export const FIRST_RUN_COST_NOTE = `It creates a read-only "${FIRST_RUN_AGENT_ID}" agent, runs it with ${FIRST_RUN_MODEL} and costs cents.`;
const DASHBOARD_DOC = "https://github.com/duskfleet/duskfleet/blob/main/docs/dashboard.md";

/** What the step costs, in the harness's own terms (dollars, a premium request, subscription usage). */
export function firstRunCostNote(harness: string): string {
  if (harness === COPILOT_HARNESS) {
    return `It creates a read-only "${FIRST_RUN_AGENT_ID}" agent on GitHub Copilot CLI (its default model) and uses a premium request of your Copilot plan; no dollar cost is reported.`;
  }
  if (harness === CODEX_HARNESS) {
    return `It creates a read-only "${FIRST_RUN_AGENT_ID}" agent on Codex CLI (read-only sandbox, its default model) and counts against your Codex subscription's usage; no dollar cost is reported.`;
  }
  if (harness === CURSOR_HARNESS) {
    return `It creates a read-only "${FIRST_RUN_AGENT_ID}" agent on Cursor Agent CLI (writes, shell commands and MCP denied, its default model) and counts against your Cursor plan's usage; no dollar cost is reported.`;
  }
  return FIRST_RUN_COST_NOTE;
}

/** The model the step asks for: haiku on Claude Code, the CLI's own default elsewhere. */
export function firstRunModel(harness: string): string | undefined {
  return harness === DEFAULT_HARNESS ? FIRST_RUN_MODEL : undefined;
}

/** Copilot rules of the step's agent: read only, writes and the shell denied explicitly. */
const COPILOT_READ_ONLY = { allowed: ["read"], disallowed: ["write", "shell"] } as const;

/**
 * Raw fields of the step's agent on `harness`, only fields that harness honours: Claude Code gets
 * `FIRST_RUN_AGENT_FIELDS`; Copilot its own read-only rules and no dollar budget; Codex the
 * read-only sandbox (`dontAsk`) and no tool rules, no dollar budget.
 */
export function firstRunAgentFields(harness: string): Record<string, unknown> {
  if (harness === DEFAULT_HARNESS) return { ...FIRST_RUN_AGENT_FIELDS };
  const { model: _m, max_budget_usd: _b, allowed_tools: _a, disallowed_tools: _d, ...base } = FIRST_RUN_AGENT_FIELDS;
  if (harness === COPILOT_HARNESS) {
    return {
      ...base,
      harness,
      allowed_tools: [...COPILOT_READ_ONLY.allowed],
      disallowed_tools: [...COPILOT_READ_ONLY.disallowed],
    };
  }
  return { ...base, harness };
}

/** Raw fields of the agent, as `agents create` would write them (kind own). */
export const FIRST_RUN_AGENT_FIELDS = {
  id: FIRST_RUN_AGENT_ID,
  description: "Read-only agent of the guided first run (duskfleet init / run --first)",
  model: FIRST_RUN_MODEL,
  permission_mode: "dontAsk",
  allowed_tools: ["Read", "Grep", "Glob"],
  disallowed_tools: ["Edit", "Write", "NotebookEdit"],
  timeout_minutes: 5,
  max_budget_usd: 0.25,
  system_prompt: "You describe projects. You never change files.",
} as const;

/** One question per call, answered by the next line of stdin; null at end of input. */
export interface Prompter {
  ask(question: string): Promise<string | null>;
  close(): void;
}

/**
 * Line reader over stdin. The async iterator buffers lines that arrive before the question is
 * asked (a pipe delivers every answer at once), which `rl.question` would drop.
 */
export function stdinPrompter(): Prompter {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(question) {
      process.stdout.write(question);
      const next = await lines.next();
      if (next.done) {
        process.stdout.write("\n");
        return null;
      }
      return next.value;
    },
    close: () => rl.close(),
  };
}

export interface FirstRunOptions {
  /** `run --first --project <path>`: skip the path question. */
  projectPath?: string | undefined;
  /** init asks "Try a first run?" first; `run --first` was the explicit request. */
  askToStart: boolean;
  /** `--harness <name>`: run on that CLI, without asking. */
  harness?: string | null | undefined;
  /** The usable harnesses when the caller already checked them (init step 2); else detected here. */
  usable?: readonly string[] | undefined;
  /** Ask which CLI when several are usable and `harness` is not given (a terminal only). */
  askHarness?: boolean | undefined;
}

const out = (s: string) => process.stdout.write(`${s}\n`);
const fail = (s: string) => process.stderr.write(`${s}\n`);

const yes = (answer: string | null, byDefault: boolean) =>
  answer === null || answer.trim() === "" ? byDefault : /^y(es)?$/i.test(answer.trim());

/** The registered project of this directory, or a new entry in the private registry. */
function projectFor(app: App, input: string): string {
  const config = app.runs.reloadConfig();
  const resolved = validateProjectPath(expandHome(input), config);
  const existing = [...config.projects.values()].find((p) => sameDirectory(p.path, resolved));
  if (existing) return existing.id;
  const base = projectIdFromPath(resolved);
  let id = base;
  for (let n = 2; config.projects.has(id); n++) id = `${base}-${n}`;
  upsertUserProject(config.userProjectsFile, {
    id,
    path: resolved,
    description: "Registered by the guided first run",
  });
  if (!app.runs.reloadConfig().projects.has(id)) {
    throw new Error(`project "${id}" was written to ${config.userProjectsFile} but did not load`);
  }
  out(`Project "${id}" registered in ${config.userProjectsFile}`);
  return id;
}

const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"];

/**
 * Why an existing `first-run` agent may not be used for this step: the step promises a
 * read-only haiku run that costs cents, so the agent must be read-only (dontAsk, Edit / Write /
 * NotebookEdit disallowed, no write or Bash tool allowed, no MCP), have a budget no larger than
 * the step's own, and not be bound to a project other than the one chosen. Empty = usable.
 */
export function firstRunAgentProblems(
  agent: AgentDefinition,
  projectPath: string,
  config: DuskFleetConfig,
  harness: string = DEFAULT_HARNESS,
): string[] {
  const problems: string[] = [];
  const runsOn = harnessOf(agent);
  if (runsOn !== harness) problems.push(`it runs on harness ${runsOn}, not ${harness}`);
  if (agent.claudeAgent) problems.push(`it is a link to the project agent "${agent.claudeAgent}"`);
  if (agent.permissionMode !== FIRST_RUN_AGENT_FIELDS.permission_mode) {
    problems.push(`permission_mode is ${agent.permissionMode}, not ${FIRST_RUN_AGENT_FIELDS.permission_mode}`);
  }
  if (runsOn === DEFAULT_HARNESS) {
    const missing = WRITE_TOOLS.filter((t) => !(agent.disallowedTools ?? []).includes(t));
    if (missing.length > 0) problems.push(`disallowed_tools lacks ${missing.join(", ")}`);
    const writers = (agent.allowedTools ?? []).filter((t) => /^(Edit|Write|NotebookEdit|Bash|mcp__)/.test(t));
    if (writers.length > 0) problems.push(`allowed_tools contains ${writers.join(", ")}`);
    const budget = agent.maxBudgetUsd;
    if (budget === undefined || budget > FIRST_RUN_AGENT_FIELDS.max_budget_usd) {
      problems.push(
        `max_budget_usd is ${budget === undefined ? "unset" : `$${budget}`}, above $${FIRST_RUN_AGENT_FIELDS.max_budget_usd}`,
      );
    }
  } else if (runsOn === COPILOT_HARNESS) {
    const missing = COPILOT_READ_ONLY.disallowed.filter((t) => !(agent.disallowedTools ?? []).includes(t));
    if (missing.length > 0) problems.push(`disallowed_tools lacks ${missing.join(", ")}`);
    const writers = (agent.allowedTools ?? []).filter((t) => !/^read(\(|$)/.test(t));
    if (writers.length > 0) problems.push(`allowed_tools contains ${writers.join(", ")}`);
  } else if (runsOn === CURSOR_HARNESS) {
    // dontAsk denies Write(**) and no shell rule means every command is rejected: allow reads only.
    const writers = (agent.allowedTools ?? []).filter((t) => !/^Read\(/.test(t));
    if (writers.length > 0) problems.push(`allowed_tools contains ${writers.join(", ")}`);
  }
  // Codex: dontAsk is its read-only sandbox (checked above); it takes no tool rules.
  if (agent.inheritMcp) problems.push("inherit_mcp is true");
  const bound = agent.project ? config.projects.get(agent.project)?.path : undefined;
  if (agent.project && (bound === undefined || !sameDirectory(bound, projectPath))) {
    problems.push(`it is bound to project "${agent.project}"`);
  }
  return problems;
}

/**
 * Before anything is registered: refuses an existing `first-run` agent that does not keep the
 * step's promise (`firstRunAgentProblems`). Throws ProjectValidationError for a bad path.
 * Returns null when the agent is usable or absent, else the message to print.
 */
function refuseExistingAgent(app: App, input: string, harness: string): string | null {
  const config = app.runs.reloadConfig();
  const existing = config.agents.get(FIRST_RUN_AGENT_ID);
  if (!existing) return null;
  const problems = firstRunAgentProblems(existing, validateProjectPath(expandHome(input), config), config, harness);
  if (problems.length === 0) return null;
  return `the existing "${FIRST_RUN_AGENT_ID}" agent (${existing.sourcePath}) is not the read-only, cheap agent this step promises: ${problems.join("; ")}. Delete or rename it (duskfleet agents), then try again.`;
}

/** The harness of an existing `first-run` agent when that CLI is usable here, else null. */
function existingAgentHarness(app: App, usable: readonly string[]): string | null {
  const existing = app.runs.reloadConfig().agents.get(FIRST_RUN_AGENT_ID);
  if (!existing) return null;
  const runsOn = harnessOf(existing);
  return usable.includes(runsOn) ? runsOn : null;
}

/** Creates the agent unless it exists; true when this step wrote the file. */
function ensureAgent(app: App, harness: string): boolean {
  const config = app.runs.reloadConfig();
  const existing = config.agents.get(FIRST_RUN_AGENT_ID);
  if (existing) {
    out(`Agent "${FIRST_RUN_AGENT_ID}" already exists (${existing.sourcePath}); using it.`);
    return false;
  }
  const agent = createAgentFromFields(
    "own",
    firstRunAgentFields(harness),
    config,
    () => app.runs.reloadConfig(),
    app.harnesses.lookup,
  );
  out(`Agent "${FIRST_RUN_AGENT_ID}" written to ${agent.sourcePath}`);
  return true;
}

/**
 * The harness of an answer to "which agent CLI?": empty = the default, else one of `usable` by
 * name (or its label's first word, case-insensitive); null = not one of them.
 */
export function harnessFromAnswer(answer: string | null, usable: readonly string[], byDefault: string): string | null {
  const a = (answer ?? "").trim().toLowerCase();
  if (!a) return byDefault;
  return usable.find((h) => h === a || harnessLabel(h).toLowerCase().split(" ")[0] === a) ?? null;
}

/**
 * Which CLI the step runs on: `--harness` (refused when not usable), else the default
 * (`defaultHarness`), asked on a terminal when more than one is usable. Returns the harness, or
 * the message of a refusal.
 */
async function chooseHarness(
  options: FirstRunOptions,
  usable: readonly string[],
  clis: readonly AgentCli[] | null,
  prompter: Prompter,
): Promise<{ harness: string } | { refused: string }> {
  if (options.harness) {
    if (!SHIPPED_HARNESSES.includes(options.harness)) {
      return { refused: `--harness must be one of ${SHIPPED_HARNESSES.join(", ")}, got "${options.harness}"` };
    }
    if (!usable.includes(options.harness)) {
      const line = clis?.find((c) => c.harness === options.harness)?.line;
      return {
        refused: `${harnessLabel(options.harness)} is not usable here${line ? ` (${line})` : ""}; check it with: duskfleet doctor --probe`,
      };
    }
    return { harness: options.harness };
  }
  const byDefault = defaultHarness(usable);
  if (!byDefault) {
    return {
      refused:
        "no agent CLI is usable (Claude Code, GitHub Copilot CLI or Codex CLI; any one is enough): run duskfleet init to see what is missing",
    };
  }
  if (!options.askHarness || usable.length < 2) return { harness: byDefault };
  const answer = await prompter.ask(`Run it on which agent CLI? [${usable.join("/")}] (default ${byDefault}) `);
  const harness = harnessFromAnswer(answer, usable, byDefault);
  return harness ? { harness } : { refused: `"${answer?.trim()}" is not one of ${usable.join(", ")}` };
}

function seconds(ms: number | null): string {
  return ms === null ? "?" : `${(ms / 1000).toFixed(1)} s`;
}

/** What the run did, what it cost, what it said, and where to see more. */
export function firstRunSummary(run: Run): string[] {
  const tokens = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
  // Copilot and Codex report no dollars (their runs are unpriced): say so rather than "$?".
  const cost =
    run.costUsd === null
      ? "no cost in dollars reported"
      : `${runCostLabel(run.billingType)} $${run.costUsd.toFixed(4)}`;
  const lines = [
    "",
    `Run ${run.id}: ${run.status}`,
    `  duration ${seconds(run.durationMs)}, ${tokens} tokens (${run.inputTokens ?? 0} in, ${run.outputTokens ?? 0} out), ${cost}`,
  ];
  if (run.reviewReasons.length > 0) {
    lines.push(
      `  needs review (${run.reviewReasons.map((r) => REVIEW_REASON_LABELS[r]).join(", ")}): Duskfleet flags every run a person should look at before trusting it; see ${DASHBOARD_DOC}`,
    );
  }
  const text = (run.resultText ?? run.error ?? "").trim();
  if (text) lines.push("", "The agent said:", ...text.split("\n").map((l) => `  ${l}`));
  lines.push("", "See more:", `  duskfleet run-info ${run.id}`, "  duskfleet dashboard");
  return lines;
}

/** Offer to delete the agent again; same rules as delete_agent (user files only, not the default agent). */
async function offerDelete(app: App, prompter: Prompter): Promise<void> {
  const config: DuskFleetConfig = app.runs.reloadConfig();
  const agent = config.agents.get(FIRST_RUN_AGENT_ID);
  if (!agent || agent.source !== "user") return;
  if (yes(await prompter.ask(`Keep the ${FIRST_RUN_AGENT_ID} agent? [Y/n] `), true)) {
    out(`Kept: ${agent.sourcePath}`);
    return;
  }
  if (config.defaultAgent === FIRST_RUN_AGENT_ID) {
    out(`Kept: "${FIRST_RUN_AGENT_ID}" is the default_agent in duskfleet.yaml; change that first.`);
    return;
  }
  deleteAgentFile(config.userAgentsDir, FIRST_RUN_AGENT_ID);
  app.runs.reloadConfig();
  out(`Deleted ${agent.sourcePath} (the run keeps its agent id)`);
}

/**
 * Runs the step; returns the exit code: 0 when the run completed (or the user declined the
 * step), 1 when it was refused or did not complete.
 */
export async function runFirstRun(app: App, options: FirstRunOptions, prompter: Prompter): Promise<number> {
  let clis: AgentCli[] | null = null;
  let usable = options.usable;
  if (!usable) {
    const config = app.runs.config;
    clis = await detectAgentClis({
      claudeBinary: config.claude.binary,
      copilotBinary: config.copilot?.binary ?? null,
      codexBinary: config.codex?.binary ?? null,
      cursorBinary: config.cursor?.binary ?? null,
      envPassthrough: config.claude.envPassthrough,
    });
    usable = clis.filter((c) => c.usable).map((c) => c.harness);
  }
  // Without --harness, an existing first-run agent on a usable CLI keeps its harness (#490): init
  // may have made it on Codex, and a later plain run --first must not refuse the agent it wrote.
  // Its own checks still apply (refuseExistingAgent); a mismatch is refused only for --harness.
  const kept = options.harness ? null : existingAgentHarness(app, usable);
  if (kept) options = { ...options, harness: kept, askHarness: false };
  // The cost stated before the first question is the default CLI's; a different choice restates it.
  const stated = options.harness && usable.includes(options.harness) ? options.harness : defaultHarness(usable);
  if (options.askToStart) {
    const note = stated ? ` ${firstRunCostNote(stated)}` : "";
    const answer = await prompter.ask(`Try a first run on a project of yours?${note} [y/N] `);
    if (!yes(answer, false)) {
      out(`First run: skipped (later: duskfleet run --first)`);
      return 0;
    }
  }
  const chosen = await chooseHarness(options, usable, clis, prompter);
  if ("refused" in chosen) {
    fail(`First run: ${chosen.refused}; nothing was run`);
    return 1;
  }
  const harness = chosen.harness;
  if (!options.askToStart || harness !== stated)
    out(`First run on ${harnessLabel(harness)}: ${firstRunCostNote(harness)}`);
  const input = options.projectPath ?? (await prompter.ask("Absolute path of a project directory: "))?.trim();
  if (!input) {
    fail("First run: no project path given; nothing was run");
    return 1;
  }
  let projectId: string;
  try {
    const refused = refuseExistingAgent(app, input, harness);
    if (refused) {
      fail(`First run: ${refused}`);
      return 1;
    }
    projectId = projectFor(app, input);
  } catch (err) {
    if (!(err instanceof ProjectValidationError)) throw err;
    fail(`First run: ${err.message}`);
    if (/allowed_project_roots/.test(err.message)) {
      fail(
        `Choose a directory inside one of them, or add its parent to allowed_project_roots in ${app.runs.config.configDir}/duskfleet.yaml (docs/configuration.md).`,
      );
    }
    return 1;
  }
  const created = ensureAgent(app, harness);
  const model = firstRunModel(harness);

  let run: Run;
  try {
    run = await app.runs.startRun({
      prompt: FIRST_RUN_PROMPT,
      agentId: FIRST_RUN_AGENT_ID,
      projectId,
      ...(model ? { model } : {}),
    });
  } catch (err) {
    // Refused before any run started: busy, a daily cap, a spent monthly budget, ...
    fail(`First run: the run was refused, nothing was run: ${err instanceof Error ? err.message : String(err)}`);
    if (created) await offerDelete(app, prompter);
    return 1;
  }
  out(
    `Run ${run.id} started on "${projectId}" with ${harnessLabel(harness)}${model ? ` (${model})` : ""}; waiting for it to end...`,
  );
  run = await app.runs.waitForRun(run.id, 24 * 60 * 60 * 1000);
  for (const line of firstRunSummary(run)) out(line);
  out("");
  // Only offer to delete a file this step wrote: a pre-existing first-run agent is the user's.
  if (created) await offerDelete(app, prompter);
  return run.status === "completed" ? 0 : 1;
}
