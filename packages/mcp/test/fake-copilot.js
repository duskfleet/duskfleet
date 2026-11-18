#!/usr/bin/env node
/**
 * Stand-in for GitHub Copilot CLI (issue #446): replays the real runs in fixtures/copilot/ so the
 * tests never launch the real CLI. The prompt (read from stdin, as the adapter sends it) picks the
 * fixture: a first line `fixture:<name>` (default `edit`).
 *
 * - The fixture's session id is replaced by the one of `--session-id` / `--resume=<id>`.
 * - `--usage-output-file <f>` gets `<name>.usage.json` when the fixture has one.
 * - `resume-unknown` prints its stderr and exits 1 with nothing on stdout; `resume-unknown-noisy`
 *   does the same between two long runs of warnings.
 * - `killed` stops before its cancellation lines and prints them on SIGTERM, exit 143.
 * - `FAKE_COPILOT_RECORD=<file>` (passed through by the test config) receives the argv, the
 *   environment's names, the prompt and the persona agent file `--add-dir` points at.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "copilot");
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv[0] === "--version") {
  process.stdout.write("GitHub Copilot CLI 1.0.112.\n");
  process.exit(0);
}

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  prompt += c;
});
process.stdin.on("end", main);

function main() {
  const name = /^fixture:([\w-]+)/.exec(prompt.trim())?.[1] ?? "edit";
  const resume = argv.find((a) => a.startsWith("--resume="))?.slice("--resume=".length);
  const sessionId = flag("--session-id") ?? resume ?? "00000000-0000-4000-8000-000000000000";

  const record = process.env.FAKE_COPILOT_RECORD;
  if (record) {
    const addDir = flag("--add-dir");
    const agent = flag("--agent");
    const personaFile = addDir && agent ? path.join(addDir, ".github", "agents", `${agent}.agent.md`) : null;
    writeFileSync(
      record,
      JSON.stringify({
        argv,
        env: Object.keys(process.env).sort(),
        prompt,
        persona: personaFile && existsSync(personaFile) ? readFileSync(personaFile, "utf8") : null,
      }),
    );
  }

  if (name === "resume-unknown") {
    process.stderr.write(readFileSync(path.join(fixtures, "resume-unknown.stderr"), "utf8"));
    process.exit(1);
  }
  if (name === "resume-unknown-noisy") {
    // The same error between two runs of warnings, each longer than the executor's 4000-character tail.
    const warnings = "Warning: something noisy happened\n".repeat(150);
    process.stderr.write(warnings, () => {
      process.stderr.write(readFileSync(path.join(fixtures, "resume-unknown.stderr"), "utf8"), () => {
        process.stderr.write(warnings, () => process.exit(1));
      });
    });
    return;
  }

  const lines = readFileSync(path.join(fixtures, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean);
  const original = JSON.parse(lines.at(-1)).sessionId;
  const out = lines.map((l) => (original ? l.split(original).join(sessionId) : l));
  const usage = path.join(fixtures, `${name}.usage.json`);
  const usageOut = flag("--usage-output-file");
  const exitCode = JSON.parse(out.at(-1)).exitCode ?? 0;
  const finish = () => {
    if (usageOut && existsSync(usage)) writeFileSync(usageOut, readFileSync(usage, "utf8"));
  };

  if (name === "killed") {
    const cut = out.findIndex((l) => l.includes('"infoType":"cancellation"'));
    // The handler first: a SIGTERM that arrives as soon as the first line is read must find it.
    process.on("SIGTERM", () => {
      process.stdout.write(`${out.slice(cut).join("\n")}\n`, () => {
        finish();
        process.exit(143);
      });
    });
    setInterval(() => {}, 1000); // wait for the signal
    process.stdout.write(`${out.slice(0, cut).join("\n")}\n`);
    return;
  }

  process.stdout.write(`${out.join("\n")}\n`, () => {
    finish();
    process.exit(exitCode);
  });
}
