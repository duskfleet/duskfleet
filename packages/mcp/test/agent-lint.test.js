/**
 * Public-repo hygiene of agent files (issue #72): create_agent / update_agent refuse home
 * paths and secret-looking values before writing, and fold add_dirs inside the home
 * directory back to ~/... The offending strings are assembled at runtime so that this
 * versioned file passes check:public and secret scanners itself.
 */
import "./helpers.js";
import assert from "node:assert/strict";
import { test } from "node:test";

import { assertAgentSpecClean, collapseHome, lintAgentSpec } from "@duskfleet/core";

const home = ["", "Users", "alice"].join("/");
const linuxHome = ["", "home", "bob"].join("/");
const winHome = ["C:", "Users", "carol"].join("\\");
const spec = (extra) => ({ id: "a", description: "", permission_mode: "acceptEdits", system_prompt: "ok", ...extra });

test("clean specs pass, placeholders and ~ paths are fine", () => {
  assert.deepEqual(
    lintAgentSpec(
      spec({
        system_prompt: "Work in ~/repo or /Users/<you>/repo, never /Users/you or /home/me. Read /etc/hosts.",
        allowed_tools: ["Bash(npm test:*)"],
        add_dirs: ["~/other", "/opt/shared"],
      }),
      home,
    ),
    [],
  );
});

test("home paths are reported per field", () => {
  const problems = lintAgentSpec(
    spec({
      system_prompt: `Edit ${home}/repo/file.ts`,
      description: `see ${linuxHome}/notes`,
      allowed_tools: [`Read(${winHome}\\x)`],
    }),
    "/nowhere",
  );
  assert.deepEqual(problems.map((p) => `${p.field}: ${p.why}`).sort(), [
    "allowed_tools[0]: Windows home path",
    "description: Linux home path",
    "system_prompt: macOS home path",
  ]);
});

test("a home directory outside the usual roots is reported too", () => {
  const odd = ["", "var", "users", "dave"].join("/");
  const problems = lintAgentSpec(spec({ system_prompt: `cd ${odd}/x` }), odd);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].why, "home directory path");
});

test("secret-looking values are reported, masked", () => {
  const secrets = [
    `sk-ant-${"a".repeat(20)}`,
    `gh${"p"}_${"b".repeat(36)}`,
    `AKIA${"C".repeat(16)}`,
    `xox${"b"}-${"1".repeat(12)}`,
    `-----BEGIN RSA ${"PRIVATE"} KEY-----`,
    `api_key = ${"z".repeat(24)}`,
  ];
  for (const s of secrets) {
    const problems = lintAgentSpec(spec({ system_prompt: `use ${s} please` }), "/nowhere");
    assert.ok(problems.length >= 1, `not caught: ${s.slice(0, 6)}`);
    for (const p of problems) assert.ok(!p.excerpt.includes(s.slice(10)), "the secret is not echoed back");
  }
  // ordinary prose about tokens is not a secret
  assert.deepEqual(lintAgentSpec(spec({ system_prompt: "Count the output tokens: 1200." }), "/nowhere"), []);
});

test("assertAgentSpecClean folds add_dirs under home to ~ and throws on the rest", () => {
  assert.equal(collapseHome(`${home}/x/y`, home), "~/x/y");
  assert.equal(collapseHome(home, home), "~");
  assert.equal(collapseHome(`${home}x/y`, home), `${home}x/y`, "a sibling with the same prefix is not home");
  const tidy = assertAgentSpecClean(spec({ add_dirs: [`${home}/other`, "/opt/shared"] }), home);
  assert.deepEqual(tidy.add_dirs, ["~/other", "/opt/shared"]);
  assert.throws(
    () => assertAgentSpecClean(spec({ add_dirs: [`${linuxHome}/other`] }), home),
    /agent "a" not written.*add_dirs\[0\]: Linux home path/,
  );
  assert.throws(() => assertAgentSpecClean(spec({ system_prompt: `cd ${home}/repo` }), home), /macOS home path/);
});
