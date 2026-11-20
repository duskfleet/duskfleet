#!/usr/bin/env node
/**
 * Stand-in for Codex CLI (issue #50): replays the real runs in fixtures/codex/ so the tests never
 * launch the real CLI. The prompt (read from stdin, as the adapter sends it with `-`) picks the
 * fixture: a first line `fixture:<name>` (default `edit`).
 *
 * - `failed-model` exits 1, as the real run did; every other fixture exits 0.
 * - `killed` prints its two lines, then waits; SIGTERM ends it with exit 143 and nothing more
 *   (the real run printed no terminal event either).
 * - `FAKE_CODEX_RECORD=<file>` (passed through by the test config) receives the argv, the
 *   environment's names and the prompt.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "codex");
const argv = process.argv.slice(2);

if (argv[0] === "--version") {
  process.stdout.write("codex-cli 0.167.1\n");
  process.exit(0);
}
if (argv[0] !== "exec" || argv.at(-1) !== "-") {
  process.stderr.write(`fake-codex: expected "exec ... -", got ${JSON.stringify(argv)}\n`);
  process.exit(2);
}

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  prompt += c;
});
process.stdin.on("end", main);

function main() {
  const name = /^fixture:([\w-]+)/.exec(prompt.trim())?.[1] ?? "edit";
  const record = process.env.FAKE_CODEX_RECORD;
  if (record) writeFileSync(record, JSON.stringify({ argv, env: Object.keys(process.env).sort(), prompt }));

  const out = readFileSync(path.join(fixtures, `${name}.jsonl`), "utf8");
  if (name === "killed") {
    // The handler first: a SIGTERM that arrives as soon as the first line is read must find it.
    process.on("SIGTERM", () => process.exit(143));
    setInterval(() => {}, 1000); // wait for the signal
    process.stdout.write(out);
    return;
  }
  process.stdout.write(out, () => process.exit(name === "failed-model" ? 1 : 0));
}
