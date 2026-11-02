/**
 * Shared test setup. CLAUDE_BIN wins over claude.binary in resolveClaudeBinary, so an
 * inherited one (a developer shell, a `serve` unit) would replace fake-claude.js with the
 * real claude. Import this module before @duskfleet/core. DUSKFLEET_DATA beats every config's
 * data_dir, so an inherited one would point the tests at a real database: dropped too.
 */
delete process.env.CLAUDE_BIN;
delete process.env.DUSKFLEET_DATA;

/** Environment for spawned CLI / MCP processes: ours without CLAUDE_BIN / DUSKFLEET_DATA, plus `extra`. */
export function testEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (!("CLAUDE_BIN" in extra)) delete env.CLAUDE_BIN;
  if (!("DUSKFLEET_DATA" in extra)) delete env.DUSKFLEET_DATA;
  return env;
}
