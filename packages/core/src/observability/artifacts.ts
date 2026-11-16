/**
 * What a run produced, as data (`run_artifacts`, issue #382). Today one kind: `pr`, the URL of a
 * pull request the run opened. Pure functions, no I/O; `RunManager` feeds them the main session's
 * Bash results and the final text when the run ends.
 *
 * No shell tokenizer and no parsing of command arguments (a closed attempt, PR #385, did not
 * converge on it): a Bash call counts when its command text contains `gh pr create`, and what it
 * printed is the evidence. Branches and commits are not extracted: the run diff
 * (`git/diff.ts`, `RunDiff.worktrees`) already records them.
 */

export type ArtifactKind = "pr";
export type ArtifactSource = "tool_result" | "result_text";

/** One artifact before it is stored. */
export interface ArtifactFinding {
  kind: ArtifactKind;
  value: string;
  source: ArtifactSource;
}

/** A stored `run_artifacts` row. */
export interface RunArtifact extends ArtifactFinding {
  id: number;
  runId: string;
  createdAt: string;
}

/** The output of one main-session Bash call whose command contains `gh pr create`. */
export interface PrCreateResult {
  output: string | null;
  isError: boolean;
}

export interface ArtifactInput {
  /** Results of the main session's `gh pr create` calls, in order. */
  prCreateResults: PrCreateResult[];
  /** Main-session `gh pr create` calls whose tool_result never arrived (the run ended first). */
  unansweredPrCreates: number;
  /** The run's final text. */
  resultText: string | null;
}

/** `https://github.com/<owner>/<repo>/pull/<n>`; `/pull/new/<branch>` (git push's hint) has no number and never matches. */
const PR_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+(?![\d])/g;

/** PR URLs in a text, each once, in order of first appearance. */
export function prUrls(text: string | null): string[] {
  if (!text) return [];
  return [...new Set(text.match(PR_URL) ?? [])];
}

/** The command text of a Bash call that may open a PR. A substring test, nothing parsed. */
export function isPrCreateCommand(command: string): boolean {
  return command.includes("gh pr create");
}

/**
 * The run's artifacts, each (kind, value) once, tool results first.
 *
 * - `tool_result`: PR URLs printed by a successful `gh pr create` call. A call that failed
 *   (`is_error`, e.g. "a pull request already exists: <url>") or printed no URL produces nothing.
 * - `result_text`: PR URLs of the final text, only when a call above already produced a PR, or
 *   when a `gh pr create` ran but no output was available to check (no tool_result, or an empty
 *   one). A PR the final text only mentions, in a run whose `gh pr create` printed none or that
 *   ran none, is not an artifact.
 */
export function extractArtifacts(input: ArtifactInput): ArtifactFinding[] {
  const out: ArtifactFinding[] = [];
  const seen = new Set<string>();
  const add = (value: string, source: ArtifactSource) => {
    if (seen.has(value)) return;
    seen.add(value);
    out.push({ kind: "pr", value, source });
  };
  for (const r of input.prCreateResults) {
    if (r.isError) continue;
    for (const url of prUrls(r.output)) add(url, "tool_result");
  }
  const unchecked = input.unansweredPrCreates > 0 || input.prCreateResults.some((r) => !r.isError && !r.output?.trim());
  if (out.length > 0 || unchecked) {
    for (const url of prUrls(input.resultText)) add(url, "result_text");
  }
  return out;
}
