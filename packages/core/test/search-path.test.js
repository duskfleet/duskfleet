/** Effective PATH: GUI-launched hosts start with a missing or minimal PATH; the install dirs go in front. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PATH_DIRS, effectivePath, isMinimalPath } from "@duskfleet/core";

const DEFAULTS = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

test("a missing, empty or system-only PATH is minimal; anything else is a real PATH", () => {
  assert.equal(isMinimalPath(undefined), true);
  assert.equal(isMinimalPath(""), true);
  assert.equal(isMinimalPath("/usr/bin:/bin:/usr/sbin:/sbin"), true, "launchd's default");
  assert.equal(isMinimalPath("/usr/bin:/bin:/usr/local/bin"), false);
  assert.equal(isMinimalPath("/home/me/.local/bin:/usr/bin"), false);
});

test("effectivePath prepends the default dirs to a minimal PATH without duplicates", () => {
  assert.equal(DEFAULT_PATH_DIRS.join(":"), DEFAULTS);
  assert.equal(effectivePath(undefined, "darwin"), DEFAULTS);
  assert.equal(effectivePath("", "linux"), DEFAULTS);
  assert.equal(effectivePath("/usr/bin:/bin:/usr/sbin:/sbin", "darwin"), `${DEFAULTS}:/usr/sbin:/sbin`);
});

test("effectivePath leaves a real PATH and Windows alone", () => {
  const real = "/home/me/.local/bin:/usr/bin:/bin";
  assert.equal(effectivePath(real, "linux"), real);
  assert.equal(effectivePath("/usr/bin", "win32"), "/usr/bin");
  assert.equal(effectivePath(undefined, "win32"), "");
});
