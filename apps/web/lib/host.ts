/** Port the dashboard listens on when `PORT` is not set (the `dev` / `start` scripts pass it). */
export const DEFAULT_PORT = "4777";

const LOOPBACK_NAMES = ["localhost", "127.0.0.1", "[::1]"];

/**
 * True when a request's `Host` header names this dashboard on the loopback interface. Anything
 * else is refused: the server binds to 127.0.0.1, so a foreign name means DNS rebinding.
 */
export function isAllowedHost(host: string | null | undefined, port: string = DEFAULT_PORT): boolean {
  if (!host) return false;
  const value = host.trim().toLowerCase();
  return LOOPBACK_NAMES.some((name) => value === `${name}:${port}`);
}
