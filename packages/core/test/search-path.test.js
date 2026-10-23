/** Effective PATH: GUI-launched hosts start with a missing or minimal PATH; the install dirs go in front. */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  DEFAULT_PATH_DIRS,
  effectivePath,
  gitEnv,
  isMinimalPath,
  pathDefaulted,
  runCommandGate,
  withEffectivePath,
} from "@duskfleet/core";

const DEFAULTS = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

test("a missing, empty or system-only PATH is minimal; anything else is a real PATH", () => {
  assert.equal(isMinimalPath(undefined), true);
  assert.equal(isMinimalPath(""), true);
  assert.equal(isMinimalPath("/usr/bin:/bin:/usr/sbin:/sbin"), true, "launchd's default");
  assert.equal(isMinimalPath("/usr/bin:/bin:/usr/local/bin"), false);
  assert.equal(isMinimalPath("/home/me/.local/bin:/usr/bin"), false);
});

test("effectivePath prepends the default dirs to a minimal PATH on macOS, without duplicates", () => {
  assert.equal(DEFAULT_PATH_DIRS.join(":"), DEFAULTS);
  assert.equal(effectivePath(undefined, "darwin"), DEFAULTS);
  assert.equal(effectivePath("", "darwin"), DEFAULTS);
  assert.equal(effectivePath("/usr/bin:/bin:/usr/sbin:/sbin", "darwin"), `${DEFAULTS}:/usr/sbin:/sbin`);
  assert.equal(pathDefaulted("/usr/bin:/bin", "darwin"), true);
});

test("effectivePath leaves a real PATH, Linux and Windows alone", () => {
  const real = "/home/me/.local/bin:/usr/bin:/bin";
  assert.equal(effectivePath(real, "darwin"), real);
  assert.equal(effectivePath(real, "linux"), real);
  assert.equal(effectivePath("/usr/bin:/bin", "linux"), "/usr/bin:/bin", "a deliberate minimal PATH on Linux");
  assert.equal(pathDefaulted("/usr/bin:/bin", "linux"), false);
  assert.equal(effectivePath("/usr/bin", "win32"), "/usr/bin");
  assert.equal(effectivePath(undefined, "win32"), "");
});

test("withEffectivePath sets PATH in a copy only when it changes", () => {
  const minimal = { PATH: "/usr/bin:/bin", HOME: "/home/me" };
  const fixed = withEffectivePath(minimal, "darwin");
  assert.equal(fixed.PATH, DEFAULTS);
  assert.equal(fixed.HOME, "/home/me");
  assert.equal(minimal.PATH, "/usr/bin:/bin", "the input is not mutated");
  assert.equal(withEffectivePath(minimal, "linux"), minimal);
  const windows = { Path: "C:\\bin" };
  assert.deepEqual(withEffectivePath(windows, "win32"), { Path: "C:\\bin" }, "no second PATH key on Windows");
});

test("a command gate runs with the effective PATH", { skip: process.platform === "win32" }, async () => {
  const saved = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  try {
    const verdict = await runCommandGate('printf %s "$PATH"', tmpdir(), 10);
    assert.equal(verdict.kind, "run");
    assert.equal(verdict.reason, process.platform === "darwin" ? DEFAULTS : "/usr/bin:/bin");
  } finally {
    process.env.PATH = saved;
  }
});

test("the git reads of a run diff get the effective PATH and no optional locks", () => {
  const env = gitEnv({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, "darwin");
  assert.equal(env.PATH, `${DEFAULTS}:/usr/sbin:/sbin`);
  assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(gitEnv({ PATH: "/usr/bin:/bin" }, "linux").PATH, "/usr/bin:/bin");
});
