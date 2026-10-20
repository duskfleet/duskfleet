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
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** At most this many files are listed in the event; `filesChanged` keeps the real count. */
export const DIFF_MAX_FILES = 200;
/** The patch file is cut at this size (at a line boundary). */
export const DIFF_MAX_PATCH_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 20_000;
/** Read a whole git output up to this much; the patch is cut to DIFF_MAX_PATCH_BYTES afterwards. */
const GIT_MAX_BUFFER = 16 * DIFF_MAX_PATCH_BYTES;

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed" | "untracked";

export interface DiffFile {
  /** Relative to the project directory. */
  path: string;
  /** Source path of a rename or copy. */
  oldPath?: string;
  status: DiffFileStatus;
  /** Lines added / deleted; null for a binary file. */
  additions: number | null;
  deletions: number | null;
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
  filesChanged: number;
  /** The first DIFF_MAX_FILES files. */
  changedFiles: DiffFile[];
  filesTruncated: boolean;
  /** `data/logs/<run_id>.diff`; null when nothing changed. */
  patchPath: string | null;
  patchBytes: number;
  patchTruncated: boolean;
}

interface GitOutput {
  ok: boolean;
  stdout: string;
  /** The output hit GIT_MAX_BUFFER; stdout holds what was read. */
  overflow: boolean;
}

function git(cwd: string, args: string[], okCodes: number[] = [0]): GitOutput {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    // Read-only: never take the index lock another git process (the agent's own) may need.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  const overflow = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS";
  const ok = overflow || (!r.error && r.status !== null && okCodes.includes(r.status));
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

/** Lines of a new file, null when it looks binary or is too big to read for a count. */
function countLines(file: string): number | null {
  try {
    const size = statSync(file).size;
    if (size > DIFF_MAX_PATCH_BYTES) return null;
    const buf = Buffer.alloc(size);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, size, 0);
    } finally {
      closeSync(fd);
    }
    if (buf.includes(0)) return null;
    if (size === 0) return 0;
    let lines = 0;
    for (const b of buf) if (b === 0x0a) lines++;
    return buf[size - 1] === 0x0a ? lines : lines + 1;
  } catch {
    return null;
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
export function captureRunDiff(cwd: string, base: string, patchPath: string): RunDiff | null {
  const common = ["--no-color", "--no-ext-diff", "--find-renames", "--relative"];
  const names = git(cwd, ["diff", "--name-status", "-z", ...common, base]);
  const nums = git(cwd, ["diff", "--numstat", "-z", ...common, base]);
  const others = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!names.ok || !nums.ok || !others.ok) return null;

  const stats = parseNumstat(nums.stdout);
  const files = parseNameStatus(names.stdout).map((f) => ({ ...f, ...(stats.get(f.path) ?? {}) }));
  const untracked = others.stdout.split("\0").filter(Boolean);
  for (const file of untracked) {
    const lines = countLines(path.join(cwd, file));
    files.push({ path: file, status: "untracked", additions: lines, deletions: lines === null ? null : 0 });
  }

  let patch = git(cwd, ["diff", ...common, base]).stdout;
  for (const file of untracked.slice(0, DIFF_MAX_FILES)) {
    if (Buffer.byteLength(patch, "utf8") > DIFF_MAX_PATCH_BYTES) break;
    // --no-index exits 1 when the files differ, which they always do here.
    patch += git(cwd, ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", file], [0, 1]).stdout;
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
    filesChanged: files.length,
    changedFiles: files.slice(0, DIFF_MAX_FILES),
    filesTruncated: files.length > DIFF_MAX_FILES,
    patchPath: written,
    patchBytes: Buffer.byteLength(capped.text, "utf8"),
    patchTruncated: capped.truncated,
  };
}
