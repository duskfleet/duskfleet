#!/usr/bin/env node
/**
 * Replays the README "Quick start" against the fake Claude (packages/mcp/test/fake-claude.js):
 * no network, no login, no cost. Run after `npm run build` (it uses packages/mcp/dist/cli.js).
 *
 * Every line of the section's ```bash blocks is either replayed (`npm run cli -- ...`, run as
 * `node packages/mcp/dist/cli.js ...`) or on the known skip list (clone, install, build, web).
 * Any other line fails the check, so a Quick start that grows a step this script does not know
 * gets noticed. The run goes against a temporary scratch project with one failing test, with
 * DUSKFLEET_CONFIG on a temporary copy of config/ (data_dir ../data lands in the temp dir too).
 *
 * Asserts: every replayed command exits 0, `doctor` / `agents create` / `run` / `runs` are all
 * there, `run` records a completed run and `runs` lists it.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(root, "packages", "mcp", "dist", "cli.js");
const fakeClaude = path.join(root, "packages", "mcp", "test", "fake-claude.js");
const PROJECT_PLACEHOLDER = "/abs/path/to/scratch-project";
const REQUIRED = ["doctor", "agents create", "run", "runs"];

/** Lines that set up the checkout (CI already did) or start a long-running process. */
const SKIP = [/^git clone /, /^cd duskfleet$/, /^npm install$/, /^npm ci\b/, /^npm run build$/, /^npm run web$/];

function fail(message) {
  process.stderr.write(`check:quickstart: ${message}\n`);
  process.exitCode = 1;
  throw new QuickstartError(message);
}

class QuickstartError extends Error {}

/** The ```bash lines of README.md between "## Quick start" and the next level-2 heading. */
export function quickstartLines(readme) {
  const start = readme.indexOf("\n## Quick start\n");
  if (start === -1) fail('README.md has no "## Quick start" section');
  const next = readme.indexOf("\n## ", start + 1);
  const section = readme.slice(start, next === -1 ? undefined : next);
  const lines = [];
  let inBash = false;
  for (const raw of section.split("\n")) {
    const line = raw.trim();
    if (!inBash && line === "```bash") inBash = true;
    else if (inBash && line.startsWith("```")) inBash = false;
    else if (inBash && line !== "") lines.push(line);
  }
  if (lines.length === 0) fail("the Quick start has no ```bash block");
  return lines;
}

/** Minimal POSIX-ish word splitting: single and double quotes, backslash escapes, `# comment`. */
export function splitWords(line) {
  const words = [];
  let word = null;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) word += line[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (c === "\\" && i + 1 < line.length) {
      word = (word ?? "") + line[++i];
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (c === "#" && word === null) {
      break;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (quote) fail(`unterminated ${quote} quote in: ${line}`);
  if (word !== null) words.push(word);
  return words;
}

function makeScratch(base) {
  const project = path.join(base, "scratch-project");
  mkdirSync(path.join(project, "test"), { recursive: true });
  writeFileSync(
    path.join(project, "package.json"),
    `${JSON.stringify({ name: "scratch-project", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  );
  writeFileSync(path.join(project, "sum.js"), "export const sum = (a, b) => a - b;\n");
  writeFileSync(
    path.join(project, "test", "sum.test.js"),
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { sum } from "../sum.js";\n\ntest("sum", () => assert.equal(sum(2, 3), 5));\n',
  );
  return realpathSync(project);
}

function main() {
  const lines = quickstartLines(readFileSync(path.join(root, "README.md"), "utf8"));
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "duskfleet-quickstart-")));
  try {
    const configDir = path.join(base, "config");
    cpSync(path.join(root, "config"), configDir, { recursive: true });
    const project = makeScratch(base);

    // As test/helpers.js does: drop an inherited CLAUDE_BIN (it could be the real claude), then
    // point it at the fake. Nothing below can reach a real Claude.
    const env = { ...process.env };
    delete env.CLAUDE_BIN;
    delete env.FAKE_CLAUDE_MODE;
    Object.assign(env, { CLAUDE_BIN: fakeClaude, DUSKFLEET_CONFIG: configDir, DUSKFLEET_LOG_LEVEL: "warn" });

    const seen = new Set();
    let runId = null;
    for (const line of lines) {
      if (SKIP.some((re) => re.test(line.replace(/\s+#.*$/, "")))) {
        process.stdout.write(`skip  ${line}\n`);
        continue;
      }
      // Split first, then substitute: splitWords reads a backslash as an escape, so a Windows
      // temp path substituted before splitting would be mangled.
      const words = splitWords(line).map((w) => w.replaceAll(PROJECT_PLACEHOLDER, project));
      if (words[0] !== "npm" || words[1] !== "run" || words[2] !== "cli" || words[3] !== "--") {
        fail(`unknown Quick start step (replay it or add it to SKIP in scripts/check-quickstart.mjs): ${line}`);
      }
      const args = words.slice(4);
      const command = args[0] === "agents" ? `agents ${args[1]}` : args[0];
      process.stdout.write(`run   ${line}\n`);
      const result = spawnSync(process.execPath, [cliEntry, ...args], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 60_000,
      });
      if (result.error) fail(`step failed to start (${result.error.message}): ${line}`);
      if (result.status !== 0) {
        fail(`step exited ${result.status}: ${line}\n${result.stderr.trim()}\n${result.stdout.trim()}`);
      }
      seen.add(command);

      if (command === "run") {
        const run = JSON.parse(result.stdout);
        if (run.status !== "completed") fail(`step recorded a ${run.status} run, expected completed: ${line}`);
        runId = run.id;
      } else if (command === "runs") {
        const runs = JSON.parse(result.stdout);
        if (!runId) fail(`"runs" comes before any "run": ${line}`);
        if (!runs.some((r) => r.id === runId)) fail(`step does not list run ${runId}: ${line}`);
      }
    }

    const missing = REQUIRED.filter((c) => !seen.has(c));
    if (missing.length > 0) fail(`the Quick start no longer has these steps: ${missing.join(", ")}`);
    process.stdout.write(`check:quickstart: ok (${seen.size} CLI steps, run ${runId} completed)\n`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    if (!(error instanceof QuickstartError)) throw error;
  }
}
