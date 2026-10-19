/**
 * Shared test setup. CLAUDE_BIN wins over claude.binary in resolveClaudeBinary, so an
 * inherited one (a developer shell, a `serve` unit) would replace fake-claude.js with the
 * real claude. Import this module before @duskfleet/core.
 */
delete process.env.CLAUDE_BIN;

/** Environment for spawned CLI / MCP processes: ours without CLAUDE_BIN, plus `extra`. */
export function testEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (!("CLAUDE_BIN" in extra)) delete env.CLAUDE_BIN;
  return env;
}
