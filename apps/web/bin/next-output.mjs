/**
 * Filters the output of `next start` for bin/start.mjs. The server binds 127.0.0.1 only, so the
 * banner's "- Network: http://127.0.0.1:4777" line is wrong (nothing on the network can reach it)
 * and repeats the "- Local:" line; it is dropped. Everything else passes through untouched.
 */

/** Strips ANSI colour codes: the banner is coloured when the output is a terminal. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with ESC
const ANSI = /\u001b\[[0-9;]*m/g;

/** True for a line of Next's start banner that only misleads on a loopback-only server. */
export function isDroppedLine(line) {
  return /^\s*-\s*Network:/.test(line.replace(ANSI, ""));
}

/**
 * Extra env for the `next start` child: FORCE_COLOR=1 keeps the banner coloured on a terminal now
 * that Next writes to a pipe. Never when the caller already chose (FORCE_COLOR or NO_COLOR set) or
 * the terminal cannot show colours (TERM=dumb): FORCE_COLOR would override both.
 */
export function colourEnv(env, isTTY) {
  if (!isTTY || env.FORCE_COLOR !== undefined || env.NO_COLOR !== undefined || env.TERM === "dumb") return {};
  return { FORCE_COLOR: "1" };
}
