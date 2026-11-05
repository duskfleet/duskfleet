/**
 * Run artifacts: what a run produced in git / GitHub (a pull request, a branch, a commit), as
 * data instead of prose. Pure functions, no I/O: `RunManager` feeds them the main session's Bash
 * calls with their output and the run's final text, and stores the findings in `run_artifacts`
 * before the terminal transition.
 *
 * What counts (issue #382), from successful calls only (`is_error` false):
 * - `pr`: a `https://github.com/<owner>/<repo>/pull/<n>` URL in the output of a `gh pr create`
 *   call, or in the final text of a run that created a PR (`createsPr`: a `gh pr create` that is
 *   the whole command or printed a PR URL; a run that only mentions a PR, a reviewer for
 *   instance, produced none);
 * - `branch`: the branch of `git push` (not a delete), `git checkout -b`, `git switch -c` and
 *   `gh pr create --head`, and the destination of a push output line (`<old>..<new> a -> a`)
 *   unless the command also runs a `git` call that prints such lines itself (fetch, pull, clone,
 *   remote, submodule);
 * - `commit`: a full 40-hex SHA, the first one printed by `git rev-parse HEAD` when that is the
 *   command's one `git` call and it runs in the run's checkout (no `cd`, `pushd`, `-C`,
 *   `--git-dir` or `--work-tree` pointing elsewhere), or the new SHA of a push output line (rare: `git push` abbreviates
 *   its SHAs unless the abbreviation length is configured to 40). Never from prose, never from a
 *   short SHA. `RunManager` drops the checkout's HEAD before the spawn.
 *
 * Here-document bodies are not commands: a body line such as `git push origin x` counts for nothing.
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

/** `git` subcommands that print `a -> b` ref lines of their own, like a push report. */
const REF_LINE_SUBCOMMANDS = new Set(["fetch", "pull", "clone", "remote", "submodule"]);

/**
 * What one main-session Bash call produced: its command and the text of its tool_result.
 * `cwd` is the run's project directory: a `git rev-parse HEAD` run elsewhere (`git -C <dir>`,
 * `--git-dir`, `--work-tree`, a `cd` / `pushd`) is another checkout's HEAD unless `<dir>` is `cwd`.
 */
export function artifactsFromBash(
  command: string,
  output: string | null,
  cwd: string | null = null,
): ArtifactFinding[] {
  const found: ArtifactFinding[] = [];
  const add = (kind: ArtifactKind, value: string | null) => {
    if (value) found.push({ kind, value, source: "tool_result" });
  };
  let prCreate = false;
  let push = false;
  let revParseHead = false;
  const commands = shellSegments(command).map(dropAssignments);
  const gitCalls = commands.filter((w) => w[0] === "git");
  // Push report lines are not read when another git call can print `a -> b` lines too: with a
  // `git fetch` next to the push, `* [new branch] x -> origin/x` would be the fetch's.
  const refLines = gitCalls.some((w) => REF_LINE_SUBCOMMANDS.has(gitSubcommand(w.slice(1))[0] ?? ""));
  const elsewhere = commands.some((w) => runsElsewhere(w, cwd));
  for (const words of commands) {
    if (words[0] === "gh" && words[1] === "pr" && words[2] === "create") {
      prCreate = true;
      add("branch", branchName(optionValue(words.slice(3), ["--head", "-H"])?.split(":").pop() ?? null));
      continue;
    }
    if (words[0] !== "git") continue;
    const [sub, ...args] = gitSubcommand(words.slice(1));
    if (sub === "push") {
      push = !refLines;
      for (const b of pushedBranches(args)) add("branch", b);
    } else if (sub === "checkout") {
      add("branch", branchName(optionValue(args, ["-b", "-B"])));
    } else if (sub === "switch") {
      add("branch", branchName(optionValue(args, ["-c", "-C", "--create", "--force-create"])));
    } else if (
      sub === "rev-parse" &&
      gitCalls.length === 1 &&
      !elsewhere &&
      args.filter((a) => !a.startsWith("-")).join(" ") === "HEAD"
    ) {
      // Only as the command's one git call, in the run's checkout, and only its first SHA line:
      // with another git call (`git rev-parse origin/main`, `git log --format=%H`) the other SHAs
      // are not the run's, and another directory's HEAD is another checkout's.
      revParseHead = true;
    }
  }
  if (output) {
    if (prCreate) for (const url of output.match(PR_URL) ?? []) add("pr", url);
    for (const raw of output.split("\n")) {
      const line = raw.trim();
      if (revParseHead && FULL_SHA.test(line)) {
        add("commit", line);
        revParseHead = false;
      }
      if (!push) continue;
      const m = PUSH_LINE.exec(raw);
      if (!m) continue;
      add("branch", branchName(stripHeads(m[2]!)));
      if (m[1] && FULL_SHA.test(m[1])) add("commit", m[1]);
    }
  }
  return found;
}

/**
 * PR URLs in the run's final text, only when the run itself ran `gh pr create` (`prCreated`):
 * otherwise a URL there is a PR the run talked about, not one it produced. Branches and commits
 * are never read from prose.
 */
export function artifactsFromResultText(text: string | null, prCreated: boolean): ArtifactFinding[] {
  if (!text || !prCreated) return [];
  return (text.match(PR_URL) ?? []).map((value) => ({ kind: "pr", value, source: "result_text" }));
}

/**
 * A successful call created a PR: it runs `gh pr create` and either that is the whole command
 * or its output holds a PR URL. A create behind `|| echo exists` can exit 0 without a PR.
 */
export function createsPr(command: string, output: string | null): boolean {
  const commands = shellSegments(command).map(dropAssignments);
  const creates = commands.filter((w) => w[0] === "gh" && w[1] === "pr" && w[2] === "create");
  if (!creates.length) return false;
  if (commands.length === 1) return true;
  return output?.match(PR_URL) != null;
}

/** `cd` / `pushd`, or a `git` call with `-C` / `--git-dir` / `--work-tree`, pointing away from `cwd`. */
function runsElsewhere(words: string[], cwd: string | null): boolean {
  const same = (dir: string | undefined) =>
    dir !== undefined && (dir === "." || (cwd !== null && dir.replace(/\/+$/, "") === cwd.replace(/\/+$/, "")));
  if (words[0] === "cd" || words[0] === "pushd") return !same(words[1]);
  if (words[0] !== "git") return false;
  for (let i = 1; i < words.length && words[i]!.startsWith("-"); i++) {
    const w = words[i]!;
    if (w === "-C") {
      if (!same(words[i + 1])) return true;
    } else if (w === "--git-dir" || w === "--work-tree" || w.startsWith("--git-dir=") || w.startsWith("--work-tree="))
      return true;
    if (GIT_VALUE_OPTIONS.has(w)) i++;
  }
  return false;
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
    const bare = spec.replace(/^\+/, "");
    // `:old-feature` deletes old-feature on the remote.
    if (bare.startsWith(":")) continue;
    const dst = bare.split(":").pop() ?? "";
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
 * each a list of words with quotes and backslashes removed. Redirections (`> out`, `2>&1`,
 * `&> log`) and comments (an unquoted `#` starting a word, to the end of the line) are dropped,
 * and so are here-document bodies (`<<EOF`, `<<-'EOF'`, up to the delimiter line).
 * Not a shell: enough to read the arguments of `git` and `gh` calls as an agent writes them.
 */
export function shellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let cur = "";
  let inToken = false;
  let quote: string | null = null;
  /** The next word is a redirection target, not an argument. */
  let dropNext = false;
  const endToken = () => {
    if (inToken) {
      if (dropNext) dropNext = false;
      else tokens.push(cur);
    }
    cur = "";
    inToken = false;
  };
  const endSegment = () => {
    endToken();
    dropNext = false;
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  /** At `command[i]`, the first char after `>`, `<` or `&>`: skip the operator's tail and maybe its target. */
  const redirect = (i: number): number => {
    while (i < command.length && ">|<".includes(command[i]!)) i++;
    if (command[i] === "&") {
      // `>&2`, `<&0`, `>&-`: a descriptor, no word follows.
      let j = i + 1;
      while (j < command.length && /[0-9-]/.test(command[j]!)) j++;
      if (j > i + 1) return j - 1;
      i++;
    }
    dropNext = true;
    return i - 1;
  };
  /** Here-documents opened on the current line, body skipped at its end: `[delimiter, strip tabs]`. */
  let heredocs: [string, boolean][] = [];
  /** At `command[i]`, the first char after `<<` (not `<<<`): read the delimiter word, quotes removed. */
  const heredoc = (i: number): number => {
    const strip = command[i] === "-";
    if (strip) i++;
    while (command[i] === " " || command[i] === "\t") i++;
    let word = "";
    let q: string | null = null;
    for (; i < command.length; i++) {
      const c = command[i]!;
      if (q) {
        if (c === q) q = null;
        else word += c;
      } else if (c === "'" || c === '"') q = c;
      else if (c === "\\" && i + 1 < command.length) word += command[++i];
      else if (" \t\n;&|()<>".includes(c)) break;
      else word += c;
    }
    if (word) heredocs.push([word, strip]);
    return i - 1;
  };
  /** At the newline `command[i]` that ends a line with here-documents: the index of the last body line's newline. */
  const skipHeredocBodies = (i: number): number => {
    for (const [delimiter, strip] of heredocs) {
      while (i < command.length) {
        const end = command.indexOf("\n", i + 1);
        const line = command.slice(i + 1, end === -1 ? command.length : end);
        i = end === -1 ? command.length : end;
        if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) break;
      }
    }
    heredocs = [];
    return i;
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
    } else if (c === "#" && !inToken) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
    } else if (c === ">" || c === "<") {
      // `2>`: the digits before the operator are its descriptor, not a word.
      if (/^\d+$/.test(cur)) {
        cur = "";
        inToken = false;
      } else endToken();
      if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") i = heredoc(i + 2);
      else i = redirect(i + 1);
    } else if (c === "&" && command[i + 1] === ">") {
      endToken();
      i = redirect(i + 2);
    } else if (c === " " || c === "\t") endToken();
    else if ("\n;&|()".includes(c)) {
      endSegment();
      if (c === "\n" && heredocs.length) i = skipHeredocBodies(i);
    } else {
      cur += c;
      inToken = true;
    }
  }
  endSegment();
  return segments;
}
