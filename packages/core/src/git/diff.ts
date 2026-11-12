/**
 * What a run changed in its project checkout, read from git. RunManager snapshots the checkout
 * before the spawn (`snapshotCheckout`: HEAD, the paths already dirty with a fingerprint of
 * each, a `git stash create` commit of the tracked dirty state, the repository's worktrees and
 * branches) and, when the run ends, compares the working tree with it (`captureRunDiff`):
 * commits made during the run plus whatever is left uncommitted, plus untracked files, minus
 * what was already dirty before and left untouched. Worktrees created (or moved) during the run
 * are diffed against their base and listed apart; a worktree removed before the end leaves its
 * branch, diffed the same way. Scoped to the project directory (a project can be a subfolder
 * of a repo).
 *
 * Plain `git` through spawnSync: no dependency, a few short reads at the end of a run.
 * Never throws for git's sake: a project that is not a repository, or a git that fails,
 * gives `null` and no diff event.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { withEffectivePath } from "../execution/search-path.js";

/** At most this many files are listed in the event; `filesChanged` keeps the real count. */
export const DIFF_MAX_FILES = 200;
/** The patch file is cut at this size (at a line boundary). */
export const DIFF_MAX_PATCH_BYTES = 1024 * 1024;
/**
 * Line counts of untracked files are read synchronously in the shared server process, so they
 * stop after this many files or this many bytes read; the rest is listed with `uncounted` and
 * the totals are marked partial. Keeps a run that leaves thousands of files from freezing the
 * other runs and the scheduler.
 */
export const DIFF_MAX_COUNTED_FILES = 1000;
export const DIFF_MAX_COUNTED_BYTES = 64 * 1024 * 1024;
/**
 * Wall-clock budget for one captureRunDiff, across every git call and line count: the reads are
 * synchronous on the shared event loop. Past it, the remaining work is skipped and marked
 * (uncounted files, a truncated patch, or no diff when the file lists themselves ran out).
 */
export const DIFF_TIME_BUDGET_MS = 30_000;
/** Budget of the snapshot taken before the spawn; past it, the dirty paths left are fingerprinted by size and mtime. */
const SNAPSHOT_TIME_BUDGET_MS = 10_000;
/** Commits listed per worktree or branch; `commitsTruncated` says when there were more. */
export const DIFF_MAX_COMMITS = 50;
const GIT_TIMEOUT_MS = 20_000;
/** Read a whole git output up to this much; the patch is cut to DIFF_MAX_PATCH_BYTES afterwards. */
const GIT_MAX_BUFFER = 16 * DIFF_MAX_PATCH_BYTES;
/** Same heuristic as git: a NUL byte in the first 8000 bytes means binary. */
const BINARY_SNIFF_BYTES = 8000;
const READ_CHUNK_BYTES = 64 * 1024;

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed" | "untracked";

export interface DiffFile {
  /** Relative to the project directory. */
  path: string;
  /** Source path of a rename or copy. */
  oldPath?: string;
  status: DiffFileStatus;
  /** Lines added / deleted; null for a binary file, or when `uncounted` is set. */
  additions: number | null;
  deletions: number | null;
  /**
   * An untracked entry whose lines were not read (not binary): past the counting caps or the
   * time budget, or not a regular file (a nested repository is listed as `dir/`).
   */
  uncounted?: true;
  /**
   * Already dirty before the run, and changed again by it. For a tracked file the counts and
   * the patch are the run's own delta (against the pre-run `git stash create`); for a file
   * untracked before the run they cover the whole file.
   */
  preexisting?: true;
}

/** A worktree the run created or moved, or the branch left by one it removed. */
export interface WorktreeDiff {
  /** Absolute path of the worktree; null when it was removed before the run ended (`removed`). */
  path: string | null;
  /** Branch checked out there (short name); null for a detached HEAD. */
  branch: string | null;
  /** The worktree is gone: what is reported is its branch, `base...head`. */
  removed: boolean;
  /** HEAD at the start for a worktree that existed already, else the merge-base with the checkout's HEAD at the start. */
  base: string;
  head: string;
  /** `git log base..head`, newest first, at most DIFF_MAX_COMMITS. */
  commits: { sha: string; subject: string }[];
  commitsTruncated: boolean;
  additions: number;
  deletions: number;
  totalsPartial: boolean;
  filesChanged: number;
  changedFiles: DiffFile[];
  filesTruncated: boolean;
}

/** Payload of a run's `diff` event. */
export interface RunDiff {
  /** HEAD before the run was spawned. */
  base: string;
  /** HEAD when the run ended (differs from base when the run committed). */
  head: string | null;
  /** Totals over every changed file, not only the listed ones. */
  additions: number;
  deletions: number;
  /** Some untracked entries are `uncounted`: the totals leave their lines out. */
  totalsPartial: boolean;
  filesChanged: number;
  /** The first DIFF_MAX_FILES files. */
  changedFiles: DiffFile[];
  filesTruncated: boolean;
  /** `data/logs/<run_id>.diff`; null when nothing changed. */
  patchPath: string | null;
  patchBytes: number;
  /** The patch is incomplete: cut at DIFF_MAX_PATCH_BYTES, or a patch read failed or ran out of time. */
  patchTruncated: boolean;
  /**
   * Files that were already dirty before the run and that it left as they were: not in the
   * lists, the totals or the patch. Absent on events recorded before the snapshot existed.
   */
  preexisting?: number;
  /** Worktrees used by the run (created, or HEAD moved), and branches left by removed ones. Absent on older events. */
  worktrees?: WorktreeDiff[];
  /** A worktree or branch could not be read (git failure or time budget): the list may miss some. */
  worktreesPartial?: true;
}

/** The checkout before the run (`snapshotCheckout`); in memory only, never stored. */
export interface CheckoutSnapshot {
  /** HEAD before the spawn. */
  base: string;
  /** Top level of the checkout (realpath); its own worktree entry is the main diff, never a worktree. */
  toplevel: string;
  /** Project directory relative to the top level (`""` or `pkg/`): worktree diffs keep the same scope. */
  prefix: string;
  /** `git stash create`: a commit of the tracked dirty state; null when there was none or it failed. */
  stash: string | null;
  /** Dirty paths (relative to the project directory, as git lists them) → fingerprint. */
  dirty: Map<string, string>;
  /** Worktree path (realpath) → HEAD and branch. */
  worktrees: Map<string, { head: string | null; branch: string | null }>;
  /** Branch (short name) → commit. */
  branches: Map<string, string>;
}

interface GitOutput {
  ok: boolean;
  stdout: string;
  /** The output hit GIT_MAX_BUFFER; stdout holds what was read. */
  overflow: boolean;
}

/**
 * Environment of the git reads: the effective PATH (a GUI host's minimal one would hide a
 * Homebrew git, see search-path.ts), and never the index lock another git process (the
 * agent's own) may need.
 */
export function gitEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return { ...withEffectivePath(env, platform), GIT_OPTIONAL_LOCKS: "0" };
}

/**
 * Run a read-only git command. An output past GIT_MAX_BUFFER is a failure unless
 * `allowOverflow` is set: a cut `-z` list would yield half paths and wrong counts.
 */
function git(
  cwd: string,
  args: string[],
  okCodes: number[] = [0],
  allowOverflow = false,
  timeoutMs = GIT_TIMEOUT_MS,
): GitOutput {
  if (timeoutMs <= 0) return { ok: false, stdout: "", overflow: false };
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
    timeout: Math.min(timeoutMs, GIT_TIMEOUT_MS),
    windowsHide: true,
    env: gitEnv(),
  });
  const overflow = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS";
  const ok = overflow ? allowOverflow : !r.error && r.status !== null && okCodes.includes(r.status);
  return { ok, stdout: typeof r.stdout === "string" ? r.stdout : "", overflow };
}

/** The commit checked out in `cwd`, or null when it is not a git repository (or has no commit yet). */
export function headSha(cwd: string): string | null {
  const r = git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const sha = r.stdout.trim();
  return r.ok && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

const STATUS: Record<string, DiffFileStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type_changed",
};

/** `git diff --name-status -z`: status, path (and a second path for renames and copies). */
export function parseNameStatus(out: string): DiffFile[] {
  const parts = out.split("\0");
  const files: DiffFile[] = [];
  let i = 0;
  while (i < parts.length) {
    const code = parts[i++] ?? "";
    if (!code) continue;
    const letter = code[0]!;
    const status = STATUS[letter] ?? "modified";
    if (letter === "R" || letter === "C") {
      const oldPath = parts[i++] ?? "";
      const newPath = parts[i++] ?? "";
      files.push({ path: newPath, oldPath, status, additions: null, deletions: null });
    } else {
      files.push({ path: parts[i++] ?? "", status, additions: null, deletions: null });
    }
  }
  return files;
}

/** `git diff --numstat -z`: `add\tdel\tpath\0`, or `add\tdel\t\0old\0new\0` for a rename. `-` = binary. */
export function parseNumstat(out: string): Map<string, { additions: number | null; deletions: number | null }> {
  const parts = out.split("\0");
  const stats = new Map<string, { additions: number | null; deletions: number | null }>();
  let i = 0;
  while (i < parts.length) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(parts[i++] ?? "");
    if (!m) continue;
    let file = m[3]!;
    if (file === "") {
      i++; // old path
      file = parts[i++] ?? "";
    }
    stats.set(file, {
      additions: m[1] === "-" ? null : Number(m[1]),
      deletions: m[2] === "-" ? null : Number(m[2]),
    });
  }
  return stats;
}

/**
 * Lines of a new file, read in chunks (no size limit of its own: the caller budgets the bytes).
 * Null when it looks binary or cannot be read.
 */
function countLines(file: string): number | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(READ_CHUNK_BYTES);
    let lines = 0;
    let offset = 0;
    let last = 0x0a;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, offset);
      if (n === 0) break;
      const chunk = buf.subarray(0, n);
      if (offset < BINARY_SNIFF_BYTES && chunk.subarray(0, BINARY_SNIFF_BYTES - offset).includes(0)) return null;
      for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, at + 1)) lines++;
      last = chunk[n - 1]!;
      offset += n;
    }
    return last === 0x0a ? lines : lines + 1;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * What an untracked entry is, without following a symlink: its target may be outside the
 * project, or a directory. `other` covers a nested repository (`dir/`) and anything unreadable.
 */
function entryKind(file: string): { kind: "file"; size: number } | { kind: "symlink" } | { kind: "other" } {
  if (file.endsWith("/")) return { kind: "other" };
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink()) return { kind: "symlink" };
    return st.isFile() ? { kind: "file", size: st.size } : { kind: "other" };
  } catch {
    return { kind: "other" };
  }
}

/** Cut a patch at `max` bytes, on the last line boundary before it. */
export function capPatch(patch: string, max = DIFF_MAX_PATCH_BYTES): { text: string; truncated: boolean } {
  const buf = Buffer.from(patch, "utf8");
  if (buf.length <= max) return { text: patch, truncated: false };
  const cut = buf.lastIndexOf(0x0a, max - 1);
  return { text: buf.subarray(0, cut >= 0 ? cut + 1 : max).toString("utf8"), truncated: true };
}

/** `git worktree list --porcelain`: one block per worktree (path, HEAD, branch or detached). */
export function parseWorktreeList(out: string): { path: string; head: string | null; branch: string | null }[] {
  const list: { path: string; head: string | null; branch: string | null }[] = [];
  let current: { path: string; head: string | null; branch: string | null } | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), head: null, branch: null };
      list.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) {
      const sha = line.slice("HEAD ".length).trim();
      current.head = /^[0-9a-f]{40,64}$/.test(sha) && !/^0+$/.test(sha) ? sha : null;
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  return list;
}

/** A path as the snapshot and the end compare it: resolved through symlinks when it exists. */
function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

const zList = (out: string) => out.split("\0").filter(Boolean);

function listWorktrees(cwd: string, timeoutMs: number): CheckoutSnapshot["worktrees"] | null {
  const r = git(cwd, ["worktree", "list", "--porcelain"], [0], false, timeoutMs);
  if (!r.ok) return null;
  return new Map(parseWorktreeList(r.stdout).map((w) => [realOr(w.path), { head: w.head, branch: w.branch }]));
}

function listBranches(cwd: string, timeoutMs: number): Map<string, string> | null {
  const r = git(cwd, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"], [0], false, timeoutMs);
  if (!r.ok) return null;
  const branches = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp > 0) branches.set(line.slice(sp + 1).replace(/^refs\/heads\//, ""), line.slice(0, sp));
  }
  return branches;
}

/**
 * What a dirty entry looks like, to tell at the end whether the run touched it. Content hash
 * within the snapshot's byte budget, size and mtime past it. Never follows a symlink.
 */
function fingerprint(file: string, mode: "content" | "stat"): string {
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink()) return `link:${readlinkSync(file)}`;
    if (!st.isFile()) return "other";
    if (mode === "stat") return `stat:${st.size}:${st.mtimeMs}`;
    return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
  } catch {
    return "missing";
  }
}

/**
 * The checkout before the run: HEAD, the dirty paths with a fingerprint each, a `git stash
 * create` commit of the tracked dirty state (objects only: no ref, the working tree and the
 * index are untouched), the worktrees and the branches. Null when `cwd` is not a git checkout
 * with a commit. Partial reads leave the matching part empty: the end diff then counts
 * those changes as the run's, as it did before the snapshot existed.
 */
export function snapshotCheckout(cwd: string, timeBudgetMs = SNAPSHOT_TIME_BUDGET_MS): CheckoutSnapshot | null {
  const base = headSha(cwd);
  if (!base) return null;
  const deadline = Date.now() + timeBudgetMs;
  const left = () => deadline - Date.now();
  const top = git(cwd, ["rev-parse", "--show-toplevel"], [0], false, left());
  const prefix = git(cwd, ["rev-parse", "--show-prefix"], [0], false, left());
  const snapshot: CheckoutSnapshot = {
    base,
    toplevel: realOr(top.ok && top.stdout.trim() ? top.stdout.trim() : cwd),
    prefix: prefix.ok ? prefix.stdout.trim() : "",
    stash: null,
    dirty: new Map(),
    worktrees: new Map(),
    branches: new Map(),
  };
  const tracked = git(cwd, ["diff", "--name-only", "-z", "--no-renames", "--relative", "HEAD"], [0], false, left());
  const others = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], [0], false, left());
  let hashed = 0;
  for (const file of [...(tracked.ok ? zList(tracked.stdout) : []), ...(others.ok ? zList(others.stdout) : [])]) {
    const abs = path.join(cwd, file);
    let mode: "content" | "stat" = "stat";
    const entry = left() > 0 ? entryKind(abs) : null;
    if (entry?.kind === "file" && hashed + entry.size <= DIFF_MAX_COUNTED_BYTES) {
      hashed += entry.size;
      mode = "content";
    }
    snapshot.dirty.set(file, fingerprint(abs, mode));
  }
  if (tracked.ok && tracked.stdout) {
    const stash = git(cwd, ["stash", "create"], [0], false, left());
    const sha = stash.stdout.trim();
    if (stash.ok && /^[0-9a-f]{40,64}$/.test(sha)) snapshot.stash = sha;
  }
  snapshot.worktrees = listWorktrees(cwd, left()) ?? new Map();
  snapshot.branches = listBranches(cwd, left()) ?? new Map();
  return snapshot;
}

// --no-textconv: a textconv driver from the repo's config would run here and replace the real patch.
const NO_DRIVERS = ["--no-color", "--no-ext-diff", "--no-textconv"];
const COMMON = [...NO_DRIVERS, "--find-renames", "--relative"];

/** Files, totals and patch of one comparison. */
interface Collected {
  files: DiffFile[];
  totalsPartial: boolean;
  patch: string;
  incomplete: boolean;
  /** Dirty before the run and left as they were: dropped. */
  preexisting: number;
}

const sum = (files: DiffFile[], key: "additions" | "deletions") => files.reduce((n, f) => n + (f[key] ?? 0), 0);

function summary(c: Collected) {
  return {
    additions: sum(c.files, "additions"),
    deletions: sum(c.files, "deletions"),
    totalsPartial: c.totalsPartial,
    filesChanged: c.files.length,
    changedFiles: c.files.slice(0, DIFF_MAX_FILES),
    filesTruncated: c.files.length > DIFF_MAX_FILES,
  };
}

/**
 * The working tree of `cwd` against `base`, untracked files included. With `before`, a path
 * that was dirty before the run and has the same fingerprint now is dropped; one changed again
 * is kept, marked `preexisting`, with its delta against the pre-run stash when it is tracked.
 */
function collectWorkingTree(
  cwd: string,
  base: string,
  left: () => number,
  before?: Pick<CheckoutSnapshot, "dirty" | "stash">,
): Collected | null {
  const names = git(cwd, ["diff", "--name-status", "-z", ...COMMON, base], [0], false, left());
  const nums = git(cwd, ["diff", "--numstat", "-z", ...COMMON, base], [0], false, left());
  const others = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], [0], false, left());
  if (!names.ok || !nums.ok || !others.ok) return null;

  const touched = (file: string): "new" | "same" | "again" => {
    const was = before?.dirty.get(file);
    if (was === undefined) return "new";
    return fingerprint(path.join(cwd, file), was.startsWith("stat:") ? "stat" : "content") === was ? "same" : "again";
  };
  let preexisting = 0;
  /** Paths left out of the patch against `base`: unchanged pre-existing ones, and those patched against the stash. */
  const excluded: string[] = [];
  const again: DiffFile[] = [];
  const stats = parseNumstat(nums.stdout);
  const files: DiffFile[] = [];
  for (const parsed of parseNameStatus(names.stdout)) {
    const f: DiffFile = { ...parsed, ...(stats.get(parsed.path) ?? {}) };
    const state = touched(f.path);
    if (state === "same") {
      preexisting++;
      excluded.push(f.path);
      continue;
    }
    if (state === "again") {
      f.preexisting = true;
      again.push(f);
    }
    files.push(f);
  }

  // The run's own delta on a tracked file it found dirty: against the pre-run stash commit.
  let againPatch = "";
  let incomplete = false;
  const stash = before?.stash;
  if (again.length && stash) {
    const specs = again.map((f) => `:(literal)${f.path}`);
    const delta = git(
      cwd,
      ["diff", "--numstat", "-z", ...NO_DRIVERS, "--no-renames", "--relative", stash, "--", ...specs],
      [0],
      false,
      left(),
    );
    if (delta.ok) {
      const deltaStats = parseNumstat(delta.stdout);
      for (const f of again) {
        const d = deltaStats.get(f.path) ?? { additions: 0, deletions: 0 };
        f.additions = d.additions;
        f.deletions = d.deletions;
        excluded.push(f.path);
      }
      const p = git(
        cwd,
        ["diff", ...NO_DRIVERS, "--no-renames", "--relative", stash, "--", ...specs],
        [0],
        true,
        left(),
      );
      if (!p.ok || p.overflow) incomplete = true;
      againPatch = p.stdout;
    }
  }

  const untracked: string[] = [];
  const kinds = new Map<string, ReturnType<typeof entryKind>["kind"]>();
  let counted = 0;
  let countedBytes = 0;
  let totalsPartial = false;
  for (const file of zList(others.stdout)) {
    const state = touched(file);
    if (state === "same") {
      preexisting++;
      continue;
    }
    untracked.push(file);
    const mark = state === "again" ? { preexisting: true as const } : {};
    const entry = entryKind(path.join(cwd, file));
    kinds.set(file, entry.kind);
    if (entry.kind === "symlink") {
      // Git's view of a link: one line holding the target path. The target is never read.
      files.push({ path: file, status: "untracked", additions: 1, deletions: 0, ...mark });
      continue;
    }
    if (entry.kind === "other") {
      files.push({ path: file, status: "untracked", additions: null, deletions: null, uncounted: true, ...mark });
      totalsPartial = true;
      continue;
    }
    if (counted >= DIFF_MAX_COUNTED_FILES || countedBytes + entry.size > DIFF_MAX_COUNTED_BYTES || left() <= 0) {
      files.push({ path: file, status: "untracked", additions: null, deletions: null, uncounted: true, ...mark });
      totalsPartial = true;
      continue;
    }
    counted++;
    countedBytes += entry.size;
    const lines = countLines(path.join(cwd, file));
    files.push({ path: file, status: "untracked", additions: lines, deletions: lines === null ? null : 0, ...mark });
  }

  // The patch alone may overflow the buffer: what was read is cut to the cap later anyway. Any
  // other failure (timeout, non-zero exit) leaves a partial or empty output: marked incomplete.
  const limit = excluded.length ? ["--", ".", ...excluded.map((p) => `:(exclude,literal)${p}`)] : [];
  const tracked = git(cwd, ["diff", ...COMMON, base, ...limit], [0], true, left());
  if (!tracked.ok || tracked.overflow) incomplete = true;
  let patch = tracked.stdout + againPatch;
  // A nested repository or an unreadable entry gets no patch (it is listed as uncounted).
  const patchable = untracked.filter((file) => kinds.get(file) !== "other");
  // Untracked files past the first DIFF_MAX_FILES are left out of the patch: say so.
  if (patchable.length > DIFF_MAX_FILES) incomplete = true;
  for (const file of patchable.slice(0, DIFF_MAX_FILES)) {
    if (Buffer.byteLength(patch, "utf8") > DIFF_MAX_PATCH_BYTES) break;
    // --no-index exits 1 when the files differ, which they always do here.
    const one = git(cwd, ["diff", ...NO_DRIVERS, "--no-index", "--", "/dev/null", file], [0, 1], true, left());
    if (!one.ok || one.overflow) incomplete = true;
    patch += one.stdout;
  }
  return { files, totalsPartial, patch, incomplete, preexisting };
}

/** A branch's committed changes, `base...head`, scoped like the project directory (`--relative` in `cwd`). */
function collectRange(cwd: string, base: string, head: string, left: () => number): Collected | null {
  const range = `${base}...${head}`;
  const names = git(cwd, ["diff", "--name-status", "-z", ...COMMON, range], [0], false, left());
  const nums = git(cwd, ["diff", "--numstat", "-z", ...COMMON, range], [0], false, left());
  if (!names.ok || !nums.ok) return null;
  const stats = parseNumstat(nums.stdout);
  const files = parseNameStatus(names.stdout).map((f) => ({ ...f, ...(stats.get(f.path) ?? {}) }));
  const patch = git(cwd, ["diff", ...COMMON, range], [0], true, left());
  return {
    files,
    totalsPartial: false,
    patch: patch.stdout,
    incomplete: !patch.ok || patch.overflow,
    preexisting: 0,
  };
}

/** `git log base..head`: newest first, at most DIFF_MAX_COMMITS. */
function commitsBetween(cwd: string, base: string, head: string, left: () => number) {
  const r = git(
    cwd,
    ["log", "--no-color", "--format=%H%x09%s", "-n", String(DIFF_MAX_COMMITS + 1), `${base}..${head}`, "--"],
    [0],
    false,
    left(),
  );
  const commits = r.ok
    ? r.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf("\t");
          return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
        })
    : [];
  return { ok: r.ok, commits: commits.slice(0, DIFF_MAX_COMMITS), truncated: commits.length > DIFF_MAX_COMMITS };
}

/**
 * Where a branch created during the run starts: the parent of its oldest commit that no other
 * branch or remote-tracking ref holds (`for-each-ref --no-contains`), i.e. the tip of the branch
 * it was created from, whether a local one or a freshly fetched `origin/main`. `head` itself
 * when it has no commit of its own; null when git cannot tell.
 */
function forkPoint(cwd: string, head: string, left: () => number): string | null {
  const refs = git(
    cwd,
    ["for-each-ref", `--no-contains=${head}`, "--format=%(objectname)", "refs/heads", "refs/remotes"],
    [0],
    false,
    left(),
  );
  if (!refs.ok) return null;
  const others = [...new Set(refs.stdout.split("\n").filter(Boolean))];
  const own = git(cwd, ["rev-list", "--topo-order", "--reverse", head, "--not", ...others], [0], false, left());
  if (!own.ok) return null;
  const oldest = own.stdout.split("\n").find(Boolean);
  if (!oldest) return head;
  const parent = git(cwd, ["rev-parse", "--verify", "--quiet", `${oldest}^`], [0], false, left());
  const sha = parent.stdout.trim();
  return parent.ok && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

interface CollectedWorktree {
  diff: WorktreeDiff;
  header: string;
  patch: string;
  incomplete: boolean;
}

/**
 * Worktrees of the repository that the run created or whose HEAD moved, then branches that
 * moved or appeared without a worktree left on them (the run removed it). The checkout's own
 * worktree and branch are the main diff, never listed here.
 */
function collectWorktrees(
  cwd: string,
  before: CheckoutSnapshot,
  left: () => number,
): { list: CollectedWorktree[]; partial: boolean } {
  const worktrees = listWorktrees(cwd, left());
  const branches = listBranches(cwd, left());
  if (!worktrees || !branches) return { list: [], partial: true };
  const list: CollectedWorktree[] = [];
  let partial = false;
  const skipBranches = new Set<string>();
  for (const own of [before.worktrees.get(before.toplevel)?.branch, worktrees.get(before.toplevel)?.branch])
    if (own) skipBranches.add(own);

  for (const [wtPath, wt] of worktrees) {
    if (wtPath === before.toplevel) continue;
    if (wt.branch) skipBranches.add(wt.branch);
    if (!wt.head) continue;
    const prev = before.worktrees.get(wtPath);
    if (prev && prev.head === wt.head) continue;
    const base = prev?.head ?? forkPoint(cwd, wt.head, left);
    const dir = path.join(wtPath, before.prefix);
    const c = base && existsSync(dir) ? collectWorkingTree(dir, base, left) : null;
    if (!base || !c) {
      partial = true;
      continue;
    }
    if (c.files.length === 0 && base === wt.head) continue;
    const log = commitsBetween(cwd, base, wt.head, left);
    list.push({
      diff: {
        path: wtPath,
        branch: wt.branch,
        removed: false,
        base,
        head: wt.head,
        commits: log.commits,
        commitsTruncated: log.truncated,
        ...summary(c),
      },
      header: `# worktree ${wtPath}${wt.branch ? ` (${wt.branch})` : ""} ${base.slice(0, 12)}..${wt.head.slice(0, 12)}\n`,
      patch: c.patch,
      incomplete: c.incomplete || !log.ok,
    });
  }

  for (const [name, head] of branches) {
    if (skipBranches.has(name)) continue;
    const prev = before.branches.get(name);
    if (prev === head) continue;
    const base = prev ?? forkPoint(cwd, head, left);
    if (!base) {
      partial = true;
      continue;
    }
    if (base === head) continue;
    const c = collectRange(cwd, base, head, left);
    if (!c) {
      partial = true;
      continue;
    }
    const log = commitsBetween(cwd, base, head, left);
    list.push({
      diff: {
        path: null,
        branch: name,
        removed: true,
        base,
        head,
        commits: log.commits,
        commitsTruncated: log.truncated,
        ...summary(c),
      },
      header: `# branch ${name} (worktree removed) ${base.slice(0, 12)}...${head.slice(0, 12)}\n`,
      patch: c.patch,
      incomplete: c.incomplete || !log.ok,
    });
  }
  return { list, partial };
}

/**
 * Compare the project directory with `base` and write the patch to `patchPath`. Null when
 * git cannot read the checkout (no diff event then). With the pre-run `before` snapshot,
 * changes already there are left out (`preexisting`) and the worktrees the run used are
 * listed (`worktrees`), their patches appended after a `# worktree` / `# branch` line.
 */
export function captureRunDiff(
  cwd: string,
  base: string,
  patchPath: string,
  timeBudgetMs = DIFF_TIME_BUDGET_MS,
  before: CheckoutSnapshot | null = null,
): RunDiff | null {
  const deadline = Date.now() + timeBudgetMs;
  const left = () => deadline - Date.now();
  const main = collectWorkingTree(cwd, base, left, before ?? undefined);
  if (!main) return null;
  let patch = main.patch;
  let incomplete = main.incomplete;
  const worktrees = before ? collectWorktrees(cwd, before, left) : null;
  for (const w of worktrees?.list ?? []) {
    if (!w.patch) continue;
    patch += w.header + w.patch;
    if (w.incomplete) incomplete = true;
  }
  const capped = capPatch(patch);
  let written: string | null = null;
  if (capped.text) {
    mkdirSync(path.dirname(patchPath), { recursive: true });
    writeFileSync(patchPath, capped.text);
    written = patchPath;
  }

  return {
    base,
    head: headSha(cwd),
    ...summary(main),
    patchPath: written,
    patchBytes: Buffer.byteLength(capped.text, "utf8"),
    patchTruncated: capped.truncated || incomplete,
    ...(before ? { preexisting: main.preexisting, worktrees: worktrees?.list.map((w) => w.diff) ?? [] } : {}),
    ...(worktrees?.partial ? { worktreesPartial: true as const } : {}),
  };
}
