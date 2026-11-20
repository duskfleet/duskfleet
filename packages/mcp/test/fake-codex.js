#!/usr/bin/env node
/**
 * Stand-in for Codex CLI (issue #50): replays the real runs in fixtures/codex/ so the tests never
 * launch the real CLI. The prompt (read from stdin, as the adapter sends it with `-`) picks the
 * fixture: a first line `fixture:<name>` (default `edit`).
 *
 * - `failed-model` exits 1, as the real run did; every other fixture exits 0.
 * - `killed` prints its two lines, then waits; SIGTERM ends it with exit 143 and nothing more
 *   (the real run printed no terminal event either).
 * - `exec resume ... <thread id> -` (issue #485) replays `resume` (or the fixture the prompt
 *   names) with `thread_id` set to the id asked for, as the real CLI reports the same id. A thread
 *   no fixture started, or any thread when `FAKE_CODEX_FORGET=1`, is unknown: nothing on stdout,
 *   `resume-unknown.stderr` on stderr (the id swapped in), exit 1.
 * - `FAKE_CODEX_RECORD=<file>` (passed through by the test config) receives the argv, the
 *   environment's names and the prompt.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const resumeId = argv[1] === "resume" ? argv.at(-2) : null;

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  prompt += c;
});
process.stdin.on("end", main);

/** The thread ids the fixtures started: the sessions this fake "has". */
function knownThreads() {
  const ids = new Set();
  for (const f of readdirSync(fixtures).filter((n) => n.endsWith(".jsonl"))) {
    const m = /"thread_id":"([^"]+)"/.exec(readFileSync(path.join(fixtures, f), "utf8"));
    if (m) ids.add(m[1]);
  }
  return ids;
}

function main() {
  const named = /^fixture:([\w-]+)/.exec(prompt.trim())?.[1];
  const name = named ?? (resumeId ? "resume" : "edit");
  const record = process.env.FAKE_CODEX_RECORD;
  if (record) writeFileSync(record, JSON.stringify({ argv, env: Object.keys(process.env).sort(), prompt }));

  if (resumeId && (process.env.FAKE_CODEX_FORGET === "1" || !knownThreads().has(resumeId))) {
    const err = readFileSync(path.join(fixtures, "resume-unknown.stderr"), "utf8");
    process.stderr.write(err.replace(/thread id \S+/, `thread id ${resumeId}`), () => process.exit(1));
    return;
  }

  let out = readFileSync(path.join(fixtures, `${name}.jsonl`), "utf8");
  if (resumeId) out = out.replace(/"thread_id":"[^"]+"/, `"thread_id":"${resumeId}"`);
  if (name === "killed") {
    // The handler first: a SIGTERM that arrives as soon as the first line is read must find it.
    process.on("SIGTERM", () => process.exit(143));
    setInterval(() => {}, 1000); // wait for the signal
    process.stdout.write(out);
    return;
  }
  process.stdout.write(out, () => process.exit(name === "failed-model" ? 1 : 0));
}
