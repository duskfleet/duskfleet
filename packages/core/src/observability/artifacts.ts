/**
 * Run artifacts: what a run produced in git / GitHub (a pull request, a branch, a commit), as
 * data instead of prose. Pure functions, no I/O: `RunManager` feeds them the main session's Bash
 * calls with their output and the run's final text, and stores the findings in `run_artifacts`
 * before the terminal transition.
 *
 * What counts (issue #382):
 * - `pr`: a `https://github.com/<owner>/<repo>/pull/<n>` URL in the output of a `gh pr create`
 *   call, or anywhere in the final text;
 * - `branch`: the branch of `git push`, `git checkout -b`, `git switch -c` and
 *   `gh pr create --head`, and the destination of a push output line (`<old>..<new> a -> a`);
 * - `commit`: a full 40-hex SHA printed by `git rev-parse HEAD` or by a push output line. Never
 *   from prose, never from a short SHA.
 */

export type ArtifactKind = "pr" | "branch" | "commit";
export type ArtifactSource = "tool_result" | "result_text";

export const ARTIFACT_KINDS: readonly ArtifactKind[] = ["pr", "branch", "commit"];

export interface ArtifactFinding {
  kind: ArtifactKind;
  /** PR URL, branch name or 40-char SHA. */
  value: string;
  source: ArtifactSource;
}

/** One stored `run_artifacts` row. */
export interface RunArtifact extends ArtifactFinding {
  id: number;
  runId: string;
  createdAt: string;
}

const PR_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;
const FULL_SHA = /^[0-9a-f]{40}$/;
/** A push output line: ` * [new branch]  a -> a`, `   1a2b3c4..5d6e7f8  a -> a`, `+ x...y a -> a (forced update)`. */
const PUSH_LINE = /^\s*[ +*=!-]?\s*(?:\[new branch\]|[0-9a-f]{7,40}\.\.\.?([0-9a-f]{7,40}))\s+\S+\s+->\s+(\S+)/;
/** Options of `git push` that take a value as the next token. */
const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);
/** Global `git` options that take a value as the next token (`git -C <dir> push`). */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/** What one main-session Bash call produced: its command and the text of its tool_result. */
export function artifactsFromBash(command: string, output: string | null): ArtifactFinding[] {
  const found: ArtifactFinding[] = [];
  const add = (kind: ArtifactKind, value: string | null) => {
    if (value) found.push({ kind, value, source: "tool_result" });
  };
  let prCreate = false;
  let push = false;
  let revParseHead = false;
  for (const tokens of shellSegments(command)) {
    const words = dropAssignments(tokens);
    if (words[0] === "gh" && words[1] === "pr" && words[2] === "create") {
      prCreate = true;
      add("branch", branchName(optionValue(words.slice(3), ["--head", "-H"])?.split(":").pop() ?? null));
      continue;
    }
    if (words[0] !== "git") continue;
    const [sub, ...args] = gitSubcommand(words.slice(1));
    if (sub === "push") {
      push = true;
      for (const b of pushedBranches(args)) add("branch", b);
    } else if (sub === "checkout") {
      add("branch", branchName(optionValue(args, ["-b", "-B"])));
    } else if (sub === "switch") {
      add("branch", branchName(optionValue(args, ["-c", "-C", "--create", "--force-create"])));
    } else if (sub === "rev-parse" && args.filter((a) => !a.startsWith("-")).join(" ") === "HEAD") {
      revParseHead = true;
    }
  }
  if (output) {
    if (prCreate) for (const url of output.match(PR_URL) ?? []) add("pr", url);
    for (const raw of output.split("\n")) {
      const line = raw.trim();
      if (revParseHead && FULL_SHA.test(line)) add("commit", line);
      if (!push) continue;
      const m = PUSH_LINE.exec(raw);
      if (!m) continue;
      add("branch", branchName(stripHeads(m[2]!)));
      if (m[1] && FULL_SHA.test(m[1])) add("commit", m[1]);
    }
  }
  return found;
}

/** PR URLs in the run's final text. Branches and commits are never read from prose. */
export function artifactsFromResultText(text: string | null): ArtifactFinding[] {
  if (!text) return [];
  return (text.match(PR_URL) ?? []).map((value) => ({ kind: "pr", value, source: "result_text" }));
}

/** One finding per (kind, value), the first one kept: tool output comes before the final text. */
export function uniqueArtifacts(findings: ArtifactFinding[]): ArtifactFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.kind}\u0000${f.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `git [global options] <sub> <args>`: the subcommand and its arguments. */
function gitSubcommand(words: string[]): string[] {
  let i = 0;
  while (i < words.length && words[i]!.startsWith("-")) {
    i += GIT_VALUE_OPTIONS.has(words[i]!) ? 2 : 1;
  }
  return words.slice(i);
}

/** Destination branches of `git push <remote> <refspec>...`; none for a delete or a tag push. */
function pushedBranches(args: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-d" || a === "--delete" || a === "--tags" || a === "--mirror") return [];
    if (PUSH_VALUE_OPTIONS.has(a)) i++;
    else if (!a.startsWith("-")) positional.push(a);
  }
  const out: string[] = [];
  for (const spec of positional.slice(1)) {
    const dst = spec.replace(/^\+/, "").split(":").pop() ?? "";
    if (dst.startsWith("refs/tags/")) continue;
    const name = branchName(stripHeads(dst));
    if (name) out.push(name);
  }
  return out;
}

/** The value of the first of `names` among `args` (`--head x` or `--head=x`). */
function optionValue(args: string[], names: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (names.includes(a)) return args[i + 1] ?? null;
    const eq = a.indexOf("=");
    if (eq > 0 && names.includes(a.slice(0, eq))) return a.slice(eq + 1);
  }
  return null;
}

function stripHeads(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

/** A plausible branch name, or null (HEAD, an option, a shell variable, a range...). */
function branchName(v: string | null): string | null {
  if (!v || v === "HEAD" || v.startsWith("-") || v.includes("..") || v.endsWith(".lock")) return null;
  return /^[A-Za-z0-9._/+-]+$/.test(v) ? v : null;
}

/** Leading `NAME=value` assignments and `env` are not the command. */
function dropAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || tokens[i] === "env")) i++;
  return tokens.slice(i);
}

/**
 * A shell command line as simple commands (split on `;`, `&`, `|`, newlines and parentheses),
 * each a list of words with quotes and backslashes removed. Not a shell: enough to read the
 * arguments of `git` and `gh` calls as an agent writes them.
 */
export function shellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let cur = "";
  let inToken = false;
  let quote: string | null = null;
  const endToken = () => {
    if (inToken) tokens.push(cur);
    cur = "";
    inToken = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inToken = true;
    } else if (c === "\\" && i + 1 < command.length) {
      const next = command[++i]!;
      if (next !== "\n") {
        cur += next;
        inToken = true;
      }
    } else if (c === " " || c === "\t") endToken();
    else if ("\n;&|()".includes(c)) endSegment();
    else {
      cur += c;
      inToken = true;
    }
  }
  endSegment();
  return segments;
}
