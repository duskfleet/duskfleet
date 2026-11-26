#!/usr/bin/env node
/**
 * Stand-in for Cursor Agent CLI (issue #467): replays the real runs in fixtures/cursor/ so the
 * tests never launch the real CLI. The prompt (read from stdin, as the adapter sends it) picks the
 * fixture: `fixture:<name>` anywhere in it (default `edit`; with `--resume`, `resume`).
 *
 * - `--version` prints the version the MCP fixtures were captured with.
 * - Without `--trust`: nothing on stdout, `untrusted.stderr`, exit 1 (as the real CLI).
 * - `failed-model`: nothing on stdout, `failed-model.stderr`, exit 1.
 * - `killed` prints its lines, then waits; SIGTERM ends it with exit 143 and nothing more.
 * - Like the real CLI, every run creates `$CURSOR_CONFIG_DIR/chats/fake/<session id>/`; `--resume
 *   <id>` reports that id as the session (the real CLI does, known or not).
 * - `FAKE_CURSOR_RECORD=<file>` (passed through by the test config) receives the argv, the
 *   environment's names, `CURSOR_CONFIG_DIR`, the `cli-config.json` it found there and the prompt.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "cursor");
const argv = process.argv.slice(2);

if (argv[0] === "--version") {
  process.stdout.write("2026.11.22-e9042b2\n");
  process.exit(0);
}
if (!argv.includes("-p")) {
  process.stderr.write(`fake-cursor: expected -p, got ${JSON.stringify(argv)}\n`);
  process.exit(2);
}
const at = argv.indexOf("--resume");
const resumeId = at === -1 ? null : argv[at + 1];

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  prompt += c;
});
process.stdin.on("end", main);

function main() {
  const configDir = process.env.CURSOR_CONFIG_DIR ?? null;
  const record = process.env.FAKE_CURSOR_RECORD;
  if (record) {
    const file = configDir ? path.join(configDir, "cli-config.json") : null;
    const config = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    writeFileSync(record, JSON.stringify({ argv, env: Object.keys(process.env).sort(), configDir, config, prompt }));
  }
  if (!argv.includes("--trust")) {
    process.stderr.write(readFileSync(path.join(fixtures, "untrusted.stderr"), "utf8"), () => process.exit(1));
    return;
  }
  const name = /fixture:([\w-]+)/.exec(prompt)?.[1] ?? (resumeId ? "resume" : "edit");
  if (name === "failed-model") {
    process.stderr.write(readFileSync(path.join(fixtures, "failed-model.stderr"), "utf8"), () => process.exit(1));
    return;
  }
  let out = readFileSync(path.join(fixtures, `${name}.jsonl`), "utf8");
  if (resumeId) out = out.replaceAll(/"session_id":"[^"]+"/g, `"session_id":"${resumeId}"`);
  const session = resumeId ?? /"session_id":"([^"]+)"/.exec(out)?.[1];
  if (configDir && session) mkdirSync(path.join(configDir, "chats", "fake", session), { recursive: true });
  if (name === "killed") {
    process.on("SIGTERM", () => process.exit(143));
    setInterval(() => {}, 1000); // wait for the signal
    process.stdout.write(out);
    return;
  }
  process.stdout.write(out, () => process.exit(0));
}
