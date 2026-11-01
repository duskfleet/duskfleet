/**
 * The guided first run (#204): the optional last step of an interactive `init`, and
 * `duskfleet run --first` to repeat it later (same code). It registers a project of the user's
 * in the private registry, creates the read-only `first-run` agent through the one agent-create
 * path in core (skipped when it exists), runs it once with haiku, prints what the run did and
 * cost, and offers to delete the agent again (the run row keeps its agent id either way).
 *
 * Duskfleet ships no agent (owner decision 2026-10-26): this step creates its own, named one,
 * so no agent-less run mode exists. Answers are read line by line from stdin (a terminal, or a
 * pipe in tests); end of input takes each question's default.
 */
import { createInterface } from "node:readline";
import {
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

/** The registered project of this directory, or a new entry in the private registry. */
function projectFor(app: App, input: string): string {
  const config = app.runs.reloadConfig();
  const resolved = validateProjectPath(expandHome(input), config);
  const existing = [...config.projects.values()].find((p) => p.path === resolved);
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

function ensureAgent(app: App): void {
  const config = app.runs.reloadConfig();
  const existing = config.agents.get(FIRST_RUN_AGENT_ID);
  if (existing) {
    out(`Agent "${FIRST_RUN_AGENT_ID}" already exists (${existing.sourcePath}); using it.`);
    return;
  }
  const agent = createAgentFromFields("own", { ...FIRST_RUN_AGENT_FIELDS }, config, () => app.runs.reloadConfig());
  out(`Agent "${FIRST_RUN_AGENT_ID}" written to ${agent.sourcePath}`);
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
  ensureAgent(app);

  let run = await app.runs.startRun({
    prompt: FIRST_RUN_PROMPT,
    agentId: FIRST_RUN_AGENT_ID,
    projectId,
    model: FIRST_RUN_MODEL,
  });
  out(`Run ${run.id} started on "${projectId}" with ${FIRST_RUN_MODEL}; waiting for it to end...`);
  run = await app.runs.waitForRun(run.id, 24 * 60 * 60 * 1000);
  for (const line of firstRunSummary(run)) out(line);
  out("");
  await offerDelete(app, prompter);
  return run.status === "completed" ? 0 : 1;
}
