/**
 * What a run changed in its project checkout, read from git. RunManager records HEAD before
 * the spawn (`headSha`) and, when the run ends, compares the working tree with it
 * (`captureRunDiff`): commits made during the run plus whatever is left uncommitted, plus
 * untracked files. Scoped to the project directory (a project can be a subfolder of a repo).
 *
 * Plain `git` through spawnSync: no dependency, a few short reads at the end of a run.
 * Never throws for git's sake: a project that is not a repository, or a git that fails,
 * gives `null` and no diff event.
 */
import { spawnSync } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
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

/**
 * Compare the project directory with `base` and write the patch to `patchPath`. Null when
 * git cannot read the checkout (no diff event then).
 */
export function captureRunDiff(
  cwd: string,
  base: string,
  patchPath: string,
  timeBudgetMs = DIFF_TIME_BUDGET_MS,
): RunDiff | null {
  const deadline = Date.now() + timeBudgetMs;
  const left = () => deadline - Date.now();
  // --no-textconv: a textconv driver from the repo's config would run here and replace the real patch.
  const noDrivers = ["--no-color", "--no-ext-diff", "--no-textconv"];
  const common = [...noDrivers, "--find-renames", "--relative"];
  const names = git(cwd, ["diff", "--name-status", "-z", ...common, base], [0], false, left());
  const nums = git(cwd, ["diff", "--numstat", "-z", ...common, base], [0], false, left());
  const others = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], [0], false, left());
  if (!names.ok || !nums.ok || !others.ok) return null;

  const stats = parseNumstat(nums.stdout);
  const files: DiffFile[] = parseNameStatus(names.stdout).map((f) => ({ ...f, ...(stats.get(f.path) ?? {}) }));
  const untracked = others.stdout.split("\0").filter(Boolean);
  const kinds = new Map<string, ReturnType<typeof entryKind>["kind"]>();
  let counted = 0;
  let countedBytes = 0;
  let totalsPartial = false;
  for (const file of untracked) {
    const entry = entryKind(path.join(cwd, file));
    kinds.set(file, entry.kind);
    if (entry.kind === "symlink") {
      // Git's view of a link: one line holding the target path. The target is never read.
      files.push({ path: file, status: "untracked", additions: 1, deletions: 0 });
      continue;
    }
    if (entry.kind === "other") {
      files.push({ path: file, status: "untracked", additions: null, deletions: null, uncounted: true });
      totalsPartial = true;
      continue;
    }
    if (counted >= DIFF_MAX_COUNTED_FILES || countedBytes + entry.size > DIFF_MAX_COUNTED_BYTES || left() <= 0) {
      files.push({ path: file, status: "untracked", additions: null, deletions: null, uncounted: true });
      totalsPartial = true;
      continue;
    }
    counted++;
    countedBytes += entry.size;
    const lines = countLines(path.join(cwd, file));
    files.push({ path: file, status: "untracked", additions: lines, deletions: lines === null ? null : 0 });
  }

  // The patch alone may overflow the buffer: what was read is cut to the cap below anyway. Any
  // other failure (timeout, non-zero exit) leaves a partial or empty output: marked incomplete.
  const tracked = git(cwd, ["diff", ...common, base], [0], true, left());
  let incomplete = !tracked.ok || tracked.overflow;
  let patch = tracked.stdout;
  // A nested repository or an unreadable entry gets no patch (it is listed as uncounted).
  const patchable = untracked.filter((file) => kinds.get(file) !== "other");
  // Untracked files past the first DIFF_MAX_FILES are left out of the patch: say so.
  if (patchable.length > DIFF_MAX_FILES) incomplete = true;
  for (const file of patchable.slice(0, DIFF_MAX_FILES)) {
    if (Buffer.byteLength(patch, "utf8") > DIFF_MAX_PATCH_BYTES) break;
    // --no-index exits 1 when the files differ, which they always do here.
    const one = git(cwd, ["diff", ...noDrivers, "--no-index", "--", "/dev/null", file], [0, 1], true, left());
    if (!one.ok || one.overflow) incomplete = true;
    patch += one.stdout;
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
    additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
    deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
    totalsPartial,
    filesChanged: files.length,
    changedFiles: files.slice(0, DIFF_MAX_FILES),
    filesTruncated: files.length > DIFF_MAX_FILES,
    patchPath: written,
    patchBytes: Buffer.byteLength(capped.text, "utf8"),
    patchTruncated: capped.truncated || incomplete,
  };
}
