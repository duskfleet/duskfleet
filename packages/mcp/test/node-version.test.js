/**
 * Node version gate: both bins print a plain message and exit 1 on Node older than 24,
 * before anything imports `node:sqlite`; on a supported Node the gate is silent.
 * The old runtime is simulated by a preload that rewrites `process.versions.node`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist");
const { nodeVersionProblem, MIN_NODE_MAJOR } = await import(path.join(dist, "node-version.js"));

const OLD_NODE = `data:text/javascript,Object.defineProperty(process.versions, "node", { value: "20.11.1" });`;

function runBin(bin, args, preload) {
  const nodeArgs = preload ? ["--import", preload] : [];
  return spawnSync(process.execPath, [...nodeArgs, path.join(dist, bin), ...args], {
    env: testEnv({ DUSKFLEET_LOG_LEVEL: "warn" }),
    encoding: "utf8",
    input: "",
    timeout: 20_000,
  });
}

test("nodeVersionProblem: below 24 is a plain message, 24 and later are fine", () => {
  assert.equal(MIN_NODE_MAJOR, 24);
  assert.equal(nodeVersionProblem("20.11.1"), "Duskfleet needs Node 24 or newer; you have v20.11.1");
  assert.equal(nodeVersionProblem("v22.5.0"), "Duskfleet needs Node 24 or newer; you have v22.5.0");
  assert.equal(nodeVersionProblem("24.0.0"), null);
  assert.equal(nodeVersionProblem("25.1.0"), null);
  assert.match(nodeVersionProblem("garbage"), /needs Node 24/);
});

for (const bin of ["cli.js", "index.js"]) {
  test(`${bin} on Node 20 prints the message to stderr and exits 1 before loading node:sqlite`, () => {
    const r = runBin(bin, ["doctor"], OLD_NODE);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr, "Duskfleet needs Node 24 or newer; you have v20.11.1\n");
    assert.equal(r.stdout, "");
  });
}

test("cli.js on a supported Node: the gate is silent", () => {
  const r = runBin("cli.js", [], null); // no command: usage, exit 2
  assert.equal(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /needs Node/);
});
