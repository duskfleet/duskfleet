/**
 * Shared test setup. CLAUDE_BIN wins over claude.binary in resolveClaudeBinary, so an
 * inherited one (a developer shell, a `serve` unit) would replace fake-claude.js with the
 * real claude. Import this module before @duskfleet/core. DUSKFLEET_DATA beats every config's
 * data_dir, so an inherited one would point the tests at a real database: dropped too.
 */
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";

delete process.env.CLAUDE_BIN;
delete process.env.DUSKFLEET_DATA;

// COPILOT_BIN beats copilot.binary and PATH: every process a test starts finds fake-copilot.js,
// never a real `copilot` installed on the machine (doctor would run it, an agent could reach it).
// The double is committed executable; set the bit anyway for a checkout that lost it.
const fakeCopilot = fileURLToPath(new URL("./fake-copilot.js", import.meta.url));
chmodSync(fakeCopilot, 0o755);
process.env.COPILOT_BIN = fakeCopilot;
// Same for CODEX_BIN: fake-codex.js, never a real `codex`.
const fakeCodex = fileURLToPath(new URL("./fake-codex.js", import.meta.url));
chmodSync(fakeCodex, 0o755);
process.env.CODEX_BIN = fakeCodex;

/** Environment for spawned CLI / MCP processes: ours without CLAUDE_BIN / DUSKFLEET_DATA, plus `extra`. */
export function testEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (!("CLAUDE_BIN" in extra)) delete env.CLAUDE_BIN;
  if (!("DUSKFLEET_DATA" in extra)) delete env.DUSKFLEET_DATA;
  return env;
}
