/**
 * The git diff of a run: HEAD recorded before the spawn, a `diff` event and a patch file
 * under data/logs when the run ends. Real git on temp repositories, fake claude.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "./helpers.js"; // before @duskfleet/core: drops an inherited CLAUDE_BIN

import {
  ClaudeCodeExecutor,
  captureRunDiff,
  DIFF_MAX_COUNTED_FILES,
  DIFF_MAX_FILES,
  DIFF_MAX_PATCH_BYTES,
  DIFF_TIME_BUDGET_MS,
  headSha,
  loadConfig,
  openDatabase,
  parseNameStatus,
  parseNumstat,
  parseWorktreeList,
  RunManager,
  RunRepository,
  snapshotCheckout,
} from "@duskfleet/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");

function git(cwd, ...args) {
  const r = spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A repository with a.txt and gone.txt committed. */
function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  writeFileSync(path.join(dir, "gone.txt"), "bye\n");
  git(dir, "add", "a.txt", "gone.txt");
  git(dir, "commit", "-q", "-m", "init");
}

function makeApp({ repo = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-diff-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  if (repo) makeRepo(project);
  else mkdirSync(project);
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\nallowed_project_roots: ["${root}"]\ndefault_agent: coder\nclaude:\n  binary: "${fakeBinary}"\n  default_timeout_minutes: 0.05\n`,
  );
  writeFileSync(path.join(configDir, "agents", "coder.md"), `---\npermission_mode: acceptEdits\n---\nBe brief.\n`);
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const executor = new ClaudeCodeExecutor({ binary: config.claude.binary, strictMcpConfig: true });
  const runs = new RunManager(config, new RunRepository(db), executor);
  const cleanup = async () => {
    runs.shutdown();
    await new Promise((r) => setTimeout(r, 200));
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, config, project: realpathSync(project), runs, cleanup };
}

test("a run in a git checkout records a diff event and the patch", async () => {
  const app = makeApp();
  try {
    const base = headSha(app.project);
    assert.match(base, /^[0-9a-f]{40}$/);
    const started = await app.runs.startRun({ prompt: "edit", projectPath: app.project });
    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.status, "completed");

    const diff = app.runs.diff(run.id);
    assert.ok(diff, "diff event recorded");
    assert.equal(diff.base, base);
    assert.equal(diff.head, base, "the run did not commit");
    const byPath = Object.fromEntries(diff.changedFiles.map((f) => [f.path, f]));
    assert.deepEqual(byPath["a.txt"], { path: "a.txt", status: "modified", additions: 2, deletions: 0 });
    assert.deepEqual(byPath["gone.txt"], { path: "gone.txt", status: "deleted", additions: 0, deletions: 1 });
    assert.deepEqual(byPath["new.txt"], { path: "new.txt", status: "untracked", additions: 1, deletions: 0 });
    assert.deepEqual(byPath["blob.bin"], { path: "blob.bin", status: "untracked", additions: null, deletions: null });
    assert.equal(diff.filesChanged, 4);
    assert.equal(diff.additions, 3);
    assert.equal(diff.deletions, 1);
    assert.equal(diff.totalsPartial, false);
    assert.equal(diff.filesTruncated, false);

    assert.equal(diff.patchPath, path.join(app.config.dataDir, "logs", `${run.id}.diff`));
    const patch = readFileSync(diff.patchPath, "utf8");
    assert.match(patch, /^\+two$/m);
    assert.match(patch, /^-bye$/m);
    assert.match(patch, /^\+fresh$/m, "untracked files are in the patch");
    assert.equal(diff.patchBytes, Buffer.byteLength(patch));
    assert.equal(diff.patchTruncated, false);

    // Recorded before the final status: a reader that sees the run ended sees its diff.
    const types = app.runs.events(run.id).map((e) => e.type);
    assert.ok(types.indexOf("diff") < types.lastIndexOf("status_change"));
  } finally {
    await app.cleanup();
  }
});

test("a run with no changes records an empty diff and no patch file", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "ok", projectPath: app.project });
    const run = await app.runs.waitForRun(started.id, 10_000);
    const diff = app.runs.diff(run.id);
    assert.equal(diff.filesChanged, 0);
    assert.deepEqual(diff.changedFiles, []);
    assert.equal(diff.patchPath, null);
    assert.equal(existsSync(path.join(app.config.dataDir, "logs", `${run.id}.diff`)), false);
  } finally {
    await app.cleanup();
  }
});

test("a project that is not a git checkout gets no diff event", async () => {
  const app = makeApp({ repo: false });
  try {
    assert.equal(headSha(app.project), null);
    const started = await app.runs.startRun({ prompt: "edit", projectPath: app.project });
    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.status, "completed");
    assert.equal(app.runs.diff(run.id), null);
    assert.ok(!app.runs.events(run.id).some((e) => e.type === "diff" || /git diff/.test(e.payload?.message ?? "")));
  } finally {
    await app.cleanup();
  }
});

test("captureRunDiff: commits since base count, renames are detected, scoped to a subfolder", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "duskfleet-diff-")));
  try {
    makeRepo(root);
    const sub = path.join(root, "pkg");
    mkdirSync(sub);
    writeFileSync(path.join(sub, "x.txt"), "x\n");
    git(root, "add", "pkg/x.txt");
    git(root, "commit", "-q", "-m", "pkg");
    const base = headSha(sub);
    git(sub, "mv", "x.txt", "y.txt");
    writeFileSync(path.join(root, "a.txt"), "outside the project\n");
    git(root, "commit", "-q", "-am", "rename and edit");
    const diff = captureRunDiff(sub, base, path.join(root, "out", "run.diff"));
    assert.notEqual(diff.head, base);
    assert.deepEqual(diff.changedFiles, [
      { path: "y.txt", oldPath: "x.txt", status: "renamed", additions: 0, deletions: 0 },
    ]);
    assert.ok(readFileSync(path.join(root, "out", "run.diff"), "utf8").includes("rename to y.txt"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("captureRunDiff caps the file list and the patch", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "duskfleet-diff-")));
  try {
    makeRepo(root);
    const base = headSha(root);
    // Tracked, so the patch comes from one git diff, not one process per file.
    for (let i = 0; i < DIFF_MAX_FILES + 5; i++)
      writeFileSync(path.join(root, `f${String(i).padStart(3, "0")}.txt`), `${i}\n`);
    writeFileSync(
      path.join(root, "big.txt"),
      `${"y".repeat(99)}\n`.repeat(Math.ceil((DIFF_MAX_PATCH_BYTES * 1.5) / 100)),
    );
    git(root, "add", ".");
    const out = path.join(root, "..", `${path.basename(root)}.diff`);
    const diff = captureRunDiff(root, base, out);
    try {
      assert.equal(diff.filesChanged, DIFF_MAX_FILES + 6);
      assert.equal(diff.changedFiles.length, DIFF_MAX_FILES);
      assert.equal(diff.filesTruncated, true);
      assert.equal(diff.patchTruncated, true);
      assert.ok(diff.patchBytes <= DIFF_MAX_PATCH_BYTES);
      const patch = readFileSync(out, "utf8");
      assert.equal(Buffer.byteLength(patch), diff.patchBytes);
      assert.ok(patch.endsWith("\n"), "cut on a line boundary");
    } finally {
      rmSync(out, { force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("captureRunDiff marks the patch incomplete past the untracked file cap", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "duskfleet-diff-")));
  try {
    makeRepo(root);
    const base = headSha(root);
    // Small files: the patch stays far under the byte cap, only the file cap leaves some out.
    for (let i = 0; i < DIFF_MAX_FILES + 3; i++)
      writeFileSync(path.join(root, `u${String(i).padStart(3, "0")}.txt`), `${i}\n`);
    const out = path.join(root, "..", `${path.basename(root)}.diff`);
    const diff = captureRunDiff(root, base, out);
    try {
      assert.ok(diff.patchBytes < DIFF_MAX_PATCH_BYTES);
      assert.equal(diff.patchTruncated, true, "3 untracked files are missing from the patch");
    } finally {
      rmSync(out, { force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("captureRunDiff never runs a textconv driver of the checkout", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "duskfleet-diff-")));
  try {
    makeRepo(root);
    const base = headSha(root);
    // Outside the working tree, so the attributes file is not itself an untracked change.
    writeFileSync(path.join(root, ".git", "info", "attributes"), "*.txt diff=shout\n");
    git(root, "config", "diff.shout.textconv", "echo TEXTCONV");
    writeFileSync(path.join(root, "a.txt"), "one\ntwo\n");
    const out = path.join(root, ".git", "run.diff");
    const diff = captureRunDiff(root, base, out);
    const patch = readFileSync(out, "utf8");
    assert.match(patch, /^\+two$/m);
    assert.ok(!patch.includes("TEXTCONV"), "the real patch, not the driver's output");
    assert.deepEqual(diff.changedFiles, [{ path: "a.txt", status: "modified", additions: 1, deletions: 0 }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("captureRunDiff counts a large untracked text file and stops counting past the caps", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "duskfleet-diff-")));
  try {
    makeRepo(root);
    const base = headSha(root);
    // Over the 1 MB patch cap: still counted, never shown as binary.
    writeFileSync(path.join(root, "big.txt"), `${"z".repeat(99)}\n`.repeat(20_000));
    const many = path.join(root, "many");
    mkdirSync(many);
    for (let i = 0; i < DIFF_MAX_COUNTED_FILES + 2; i++) writeFileSync(path.join(many, `${i}.txt`), "l\n");
    const out = path.join(root, ".git", "run.diff");
    const diff = captureRunDiff(root, base, out);
    const big = diff.changedFiles.find((f) => f.path === "big.txt");
    assert.deepEqual(big, { path: "big.txt", status: "untracked", additions: 20_000, deletions: 0 });
    assert.equal(diff.filesChanged, DIFF_MAX_COUNTED_FILES + 3);
    assert.equal(diff.totalsPartial, true);
    assert.equal(diff.additions, 20_000 + DIFF_MAX_COUNTED_FILES - 1, "only the counted files are in the totals");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("captureRunDiff: an untracked symlink is one line, a nested repository is not counted", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "duskfleet-diff-")));
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "duskfleet-diff-outside-")));
  try {
    makeRepo(root);
    const base = headSha(root);
    writeFileSync(path.join(outside, "long.txt"), "x\n".repeat(30));
    symlinkSync(path.join(outside, "long.txt"), path.join(root, "to-file"));
    symlinkSync(outside, path.join(root, "to-dir"));
    makeRepo(path.join(root, "nested"));
    const out = path.join(root, ".git", "run.diff");
    const diff = captureRunDiff(root, base, out);
    const byPath = Object.fromEntries(diff.changedFiles.map((f) => [f.path, f]));
    assert.deepEqual(byPath["to-file"], { path: "to-file", status: "untracked", additions: 1, deletions: 0 });
    assert.deepEqual(byPath["to-dir"], { path: "to-dir", status: "untracked", additions: 1, deletions: 0 });
    assert.deepEqual(byPath["nested/"], {
      path: "nested/",
      status: "untracked",
      additions: null,
      deletions: null,
      uncounted: true,
    });
    assert.equal(diff.additions, 2);
    assert.equal(diff.totalsPartial, true);
    assert.equal(diff.patchTruncated, false, "the nested repository is skipped, not a failed read");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("captureRunDiff: past the time budget the work is skipped and marked, never reported complete", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "duskfleet-diff-")));
  try {
    makeRepo(root);
    const base = headSha(root);
    writeFileSync(path.join(root, "a.txt"), "one\ntwo\n");
    const out = path.join(root, ".git", "run.diff");
    // No time at all: the file lists cannot be read, so there is no diff rather than a wrong one.
    assert.equal(captureRunDiff(root, base, out, 0), null);
    assert.ok(DIFF_TIME_BUDGET_MS > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("captureRunDiff: a patch read that fails marks the patch incomplete", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "duskfleet-diff-")));
  const locked = path.join(root, "locked.txt");
  try {
    makeRepo(root);
    const base = headSha(root);
    writeFileSync(path.join(root, "a.txt"), "one\ntwo\n");
    writeFileSync(locked, "secret\n");
    chmodSync(locked, 0);
    const diff = captureRunDiff(root, base, path.join(root, ".git", "run.diff"));
    assert.ok(diff.changedFiles.some((f) => f.path === "locked.txt"));
    assert.equal(diff.patchTruncated, true, "git diff --no-index failed on the unreadable file");
  } finally {
    if (existsSync(locked)) chmodSync(locked, 0o644);
    rmSync(root, { recursive: true, force: true });
  }
});

/** A temp repository (realpath) and its cleanup; `snapshot` and `capture` wrap the pair of calls a run makes. */
function tempRepo() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "duskfleet-diff-")));
  const repo = path.join(root, "repo");
  makeRepo(repo);
  git(repo, "branch", "-M", "main");
  const out = path.join(root, "run.diff");
  return {
    root,
    repo,
    out,
    capture: (before) => captureRunDiff(repo, before.base, out, undefined, before),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("a dirty checkout the run leaves alone: empty diff with the pre-existing count", () => {
  const t = tempRepo();
  try {
    writeFileSync(path.join(t.repo, "a.txt"), "owner edit\n");
    writeFileSync(path.join(t.repo, "notes.txt"), "owner's untracked file\n");
    const before = snapshotCheckout(t.repo);
    assert.equal(before.dirty.size, 2);
    assert.ok(before.stash, "git stash create recorded the tracked dirty state");
    assert.equal(git(t.repo, "stash", "list"), "", "no stash entry was added");
    const diff = t.capture(before);
    assert.equal(diff.filesChanged, 0);
    assert.deepEqual(diff.changedFiles, []);
    assert.equal(diff.preexisting, 2);
    assert.deepEqual(diff.worktrees, []);
    assert.equal(diff.patchPath, null);
    assert.equal(readFileSync(path.join(t.repo, "a.txt"), "utf8"), "owner edit\n", "the working tree is untouched");
  } finally {
    t.cleanup();
  }
});

test("a file dirty before and changed again shows the run's delta; a new change is reported in full", () => {
  const t = tempRepo();
  try {
    writeFileSync(path.join(t.repo, "a.txt"), "one\nowner\n");
    writeFileSync(path.join(t.repo, "gone.txt"), "bye\nowner\n");
    const before = snapshotCheckout(t.repo);
    // The run: a.txt gets one more line, gone.txt is left as the owner had it, new.txt is created.
    writeFileSync(path.join(t.repo, "a.txt"), "one\nowner\nagent\n");
    writeFileSync(path.join(t.repo, "new.txt"), "fresh\n");
    const diff = t.capture(before);
    const byPath = Object.fromEntries(diff.changedFiles.map((f) => [f.path, f]));
    assert.deepEqual(byPath["a.txt"], {
      path: "a.txt",
      status: "modified",
      additions: 1,
      deletions: 0,
      preexisting: true,
    });
    assert.deepEqual(byPath["new.txt"], { path: "new.txt", status: "untracked", additions: 1, deletions: 0 });
    assert.equal(byPath["gone.txt"], undefined);
    assert.equal(diff.preexisting, 1);
    assert.equal(diff.additions, 2);
    const patch = readFileSync(t.out, "utf8");
    assert.match(patch, /^\+agent$/m);
    assert.doesNotMatch(patch, /^\+owner$/m, "the owner's lines are not the run's");
    assert.ok(!patch.includes("gone.txt"));
  } finally {
    t.cleanup();
  }
});

test("a worktree created, committed and pushed during the run is listed with its commits and patch", () => {
  const t = tempRepo();
  try {
    const remote = path.join(t.root, "remote.git");
    git(t.root, "init", "-q", "--bare", remote);
    git(t.repo, "remote", "add", "origin", remote);
    git(t.repo, "push", "-q", "origin", "main");
    // Upstream moves on after the checkout's HEAD: the worktree starts from the fetched tip.
    const other = path.join(t.root, "other");
    git(t.root, "clone", "-q", remote, other);
    writeFileSync(path.join(other, "upstream.txt"), "not the run's\n");
    git(other, "add", "upstream.txt");
    git(other, "commit", "-q", "-m", "upstream");
    git(other, "push", "-q", "origin", "HEAD:main");

    // As in a project that ignores its agents' worktrees folder.
    writeFileSync(path.join(t.repo, ".git", "info", "exclude"), ".claude/\n");
    const upstreamTip = git(other, "rev-parse", "HEAD").trim();

    const before = snapshotCheckout(t.repo);
    git(t.repo, "fetch", "-q", "origin");
    const wt = path.join(t.repo, ".claude", "worktrees", "issue-1");
    git(t.repo, "worktree", "add", "-q", "-b", "issue/1-x", wt, "origin/main");
    writeFileSync(path.join(wt, "feature.txt"), "a\nb\n");
    git(wt, "add", "feature.txt");
    git(wt, "commit", "-q", "-m", "feature (#1)");
    git(wt, "push", "-q", "-u", "origin", "issue/1-x");
    writeFileSync(path.join(wt, "a.txt"), "one\nleft uncommitted\n");

    const diff = t.capture(before);
    assert.equal(diff.filesChanged, 0, "the checkout itself is untouched");
    assert.equal(diff.worktrees.length, 1);
    const [w] = diff.worktrees;
    assert.equal(w.path, wt);
    assert.equal(w.branch, "issue/1-x");
    assert.equal(w.removed, false);
    assert.equal(w.base, upstreamTip, "based on the fetched tip it was created from, not the checkout's HEAD");
    assert.deepEqual(
      w.commits.map((c) => c.subject),
      ["feature (#1)"],
    );
    const byPath = Object.fromEntries(w.changedFiles.map((f) => [f.path, f]));
    assert.deepEqual(byPath["feature.txt"], { path: "feature.txt", status: "added", additions: 2, deletions: 0 });
    assert.deepEqual(byPath["a.txt"], { path: "a.txt", status: "modified", additions: 1, deletions: 0 });
    assert.equal(byPath["upstream.txt"], undefined, "upstream commits are not the run's");
    assert.equal(w.filesChanged, 2);
    const patch = readFileSync(t.out, "utf8");
    assert.match(patch, /^# worktree .*issue-1 \(issue\/1-x\) /m);
    assert.match(patch, /^\+left uncommitted$/m);
    assert.equal(diff.patchPath, t.out);
  } finally {
    t.cleanup();
  }
});

test("a worktree removed before the run ends still yields its branch's diff", () => {
  const t = tempRepo();
  try {
    writeFileSync(path.join(t.repo, ".git", "info", "exclude"), ".claude/\n");
    // A worktree that exists before the run and that the run leaves alone is not listed.
    git(t.repo, "worktree", "add", "-q", "-b", "idle", path.join(t.repo, ".claude", "worktrees", "idle"));
    const before = snapshotCheckout(t.repo);
    const wt = path.join(t.repo, ".claude", "worktrees", "issue-2");
    git(t.repo, "worktree", "add", "-q", "-b", "issue/2-y", wt, "main");
    writeFileSync(path.join(wt, "a.txt"), "one\ntwo\n");
    git(wt, "commit", "-q", "-am", "edit a (#2)");
    git(t.repo, "worktree", "remove", wt);

    const diff = t.capture(before);
    assert.equal(diff.filesChanged, 0);
    assert.equal(diff.worktrees.length, 1);
    const [w] = diff.worktrees;
    assert.equal(w.path, null);
    assert.equal(w.branch, "issue/2-y");
    assert.equal(w.removed, true);
    assert.equal(w.base, before.base);
    assert.deepEqual(
      w.commits.map((c) => c.subject),
      ["edit a (#2)"],
    );
    assert.deepEqual(w.changedFiles, [{ path: "a.txt", status: "modified", additions: 1, deletions: 0 }]);
    assert.match(readFileSync(t.out, "utf8"), /^# branch issue\/2-y \(worktree removed\) /m);
  } finally {
    t.cleanup();
  }
});

test("git worktree list --porcelain parsing", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(
    parseWorktreeList(
      `worktree /r\nHEAD ${sha}\nbranch refs/heads/main\n\nworktree /r/wt\nHEAD ${sha}\ndetached\n\nworktree /r/bare\nbare\n`,
    ),
    [
      { path: "/r", head: sha, branch: "main" },
      { path: "/r/wt", head: sha, branch: null },
      { path: "/r/bare", head: null, branch: null },
    ],
  );
});

test("name-status and numstat -z parsing", () => {
  assert.deepEqual(parseNameStatus("M\0a b.txt\0R087\0old.txt\0new.txt\0A\0n.txt\0"), [
    { path: "a b.txt", status: "modified", additions: null, deletions: null },
    { path: "new.txt", oldPath: "old.txt", status: "renamed", additions: null, deletions: null },
    { path: "n.txt", status: "added", additions: null, deletions: null },
  ]);
  const stats = parseNumstat("3\t1\ta b.txt\0" + "2\t2\t\0old.txt\0new.txt\0" + "-\t-\tbin.png\0");
  assert.deepEqual(stats.get("a b.txt"), { additions: 3, deletions: 1 });
  assert.deepEqual(stats.get("new.txt"), { additions: 2, deletions: 2 });
  assert.deepEqual(stats.get("bin.png"), { additions: null, deletions: null });
  assert.equal(stats.has("old.txt"), false);
});
