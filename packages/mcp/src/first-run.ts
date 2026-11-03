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
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  type AgentDefinition,
  createAgentFromFields,
  type DuskFleetConfig,
  deleteAgentFile,
  expandHome,
  ProjectValidationError,
  projectIdFromPath,
  REVIEW_REASON_LABELS,
  type Run,
  runCostLabel,
  upsertUserProject,
  validateProjectPath,
} from "@duskfleet/core";
import type { App } from "./bootstrap.js";

export const FIRST_RUN_AGENT_ID = "first-run";
export const FIRST_RUN_MODEL = "haiku";
export const FIRST_RUN_PROMPT = "Describe this project in three sentences. Do not change any file.";
export const FIRST_RUN_COST_NOTE = `It creates a read-only "${FIRST_RUN_AGENT_ID}" agent, runs it with ${FIRST_RUN_MODEL} and costs cents.`;
const DASHBOARD_DOC = "https://github.com/duskfleet/duskfleet/blob/main/docs/dashboard.md";

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
}

const out = (s: string) => process.stdout.write(`${s}\n`);
const fail = (s: string) => process.stderr.write(`${s}\n`);

const yes = (answer: string | null, byDefault: boolean) =>
  answer === null || answer.trim() === "" ? byDefault : /^y(es)?$/i.test(answer.trim());

const realOrRaw = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * Same directory? validateProjectPath returns a realpath, the loader only path.resolve's the
 * registry entries: a project registered through a symlink (/tmp on macOS) must still match.
 */
export const sameDirectory = (a: string, b: string): boolean => a === b || realOrRaw(a) === realOrRaw(b);

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
export function firstRunAgentProblems(agent: AgentDefinition, projectPath: string, config: DuskFleetConfig): string[] {
  const problems: string[] = [];
  if (agent.claudeAgent) problems.push(`it is a link to the project agent "${agent.claudeAgent}"`);
  if (agent.permissionMode !== FIRST_RUN_AGENT_FIELDS.permission_mode) {
    problems.push(`permission_mode is ${agent.permissionMode}, not ${FIRST_RUN_AGENT_FIELDS.permission_mode}`);
  }
  const missing = WRITE_TOOLS.filter((t) => !(agent.disallowedTools ?? []).includes(t));
  if (missing.length > 0) problems.push(`disallowed_tools lacks ${missing.join(", ")}`);
  const writers = (agent.allowedTools ?? []).filter((t) => /^(Edit|Write|NotebookEdit|Bash|mcp__)/.test(t));
  if (writers.length > 0) problems.push(`allowed_tools contains ${writers.join(", ")}`);
  if (agent.inheritMcp) problems.push("inherit_mcp is true");
  const budget = agent.maxBudgetUsd;
  if (budget === undefined || budget > FIRST_RUN_AGENT_FIELDS.max_budget_usd) {
    problems.push(
      `max_budget_usd is ${budget === undefined ? "unset" : `$${budget}`}, above $${FIRST_RUN_AGENT_FIELDS.max_budget_usd}`,
    );
  }
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
function refuseExistingAgent(app: App, input: string): string | null {
  const config = app.runs.reloadConfig();
  const existing = config.agents.get(FIRST_RUN_AGENT_ID);
  if (!existing) return null;
  const problems = firstRunAgentProblems(existing, validateProjectPath(expandHome(input), config), config);
  if (problems.length === 0) return null;
  return `the existing "${FIRST_RUN_AGENT_ID}" agent (${existing.sourcePath}) is not the read-only, cheap agent this step promises: ${problems.join("; ")}. Delete or rename it (duskfleet agents), then try again.`;
}

/** Creates the agent unless it exists; true when this step wrote the file. */
function ensureAgent(app: App): boolean {
  const config = app.runs.reloadConfig();
  const existing = config.agents.get(FIRST_RUN_AGENT_ID);
  if (existing) {
    out(`Agent "${FIRST_RUN_AGENT_ID}" already exists (${existing.sourcePath}); using it.`);
    return false;
  }
  const agent = createAgentFromFields("own", { ...FIRST_RUN_AGENT_FIELDS }, config, () => app.runs.reloadConfig());
  out(`Agent "${FIRST_RUN_AGENT_ID}" written to ${agent.sourcePath}`);
  return true;
}

function seconds(ms: number | null): string {
  return ms === null ? "?" : `${(ms / 1000).toFixed(1)} s`;
}

/** What the run did, what it cost, what it said, and where to see more. */
export function firstRunSummary(run: Run): string[] {
  const tokens = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
  const cost = run.costUsd === null ? "unknown" : `$${run.costUsd.toFixed(4)}`;
  const lines = [
    "",
    `Run ${run.id}: ${run.status}`,
    `  duration ${seconds(run.durationMs)}, ${tokens} tokens (${run.inputTokens ?? 0} in, ${run.outputTokens ?? 0} out), ${runCostLabel(run.billingType)} ${cost}`,
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
  if (options.askToStart) {
    const answer = await prompter.ask(`Try a first run on a project of yours? ${FIRST_RUN_COST_NOTE} [y/N] `);
    if (!yes(answer, false)) {
      out(`First run: skipped (later: duskfleet run --first)`);
      return 0;
    }
  } else {
    out(`First run: ${FIRST_RUN_COST_NOTE}`);
  }
  const input = options.projectPath ?? (await prompter.ask("Absolute path of a project directory: "))?.trim();
  if (!input) {
    fail("First run: no project path given; nothing was run");
    return 1;
  }
  let projectId: string;
  try {
    const refused = refuseExistingAgent(app, input);
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
  const created = ensureAgent(app);

  let run: Run;
  try {
    run = await app.runs.startRun({
      prompt: FIRST_RUN_PROMPT,
      agentId: FIRST_RUN_AGENT_ID,
      projectId,
      model: FIRST_RUN_MODEL,
    });
  } catch (err) {
    // Refused before any run started: busy, a daily cap, a spent monthly budget, ...
    fail(`First run: the run was refused, nothing was run: ${err instanceof Error ? err.message : String(err)}`);
    if (created) await offerDelete(app, prompter);
    return 1;
  }
  out(`Run ${run.id} started on "${projectId}" with ${FIRST_RUN_MODEL}; waiting for it to end...`);
  run = await app.runs.waitForRun(run.id, 24 * 60 * 60 * 1000);
  for (const line of firstRunSummary(run)) out(line);
  out("");
  // Only offer to delete a file this step wrote: a pre-existing first-run agent is the user's.
  if (created) await offerDelete(app, prompter);
  return run.status === "completed" ? 0 : 1;
}
