/**
 * The agent CLI an agent or a run is on (issue #478), and whether this host can start it. Pure:
 * `data.ts` builds the host map from core (`SHIPPED_HARNESSES`, `resolveCopilotBinary`, `resolveCodexBinary`), the
 * lists only render the result.
 */

/** The harness of an agent whose file sets no `harness:` (core's `DEFAULT_HARNESS`). */
export const DEFAULT_HARNESS_NAME = "claude";

/**
 * Harnesses Duskfleet ships, by name: null = registered on this host, a string = why it is not
 * (its CLI was not found). A name absent from the map has no adapter at all.
 */
export type HostHarnesses = ReadonlyMap<string, string | null>;

export interface HarnessInfo {
  /** As the agent file spells it (`claude`, `copilot`, `codex`). */
  name: string;
  /** Null when this host can start it; else a short label and the reason, as `doctor` words it. */
  missing: { label: "not installed" | "not registered"; reason: string } | null;
}

export function harnessInfo(name: string | null | undefined, host: HostHarnesses): HarnessInfo {
  const n = name || DEFAULT_HARNESS_NAME;
  if (!host.has(n))
    return {
      name: n,
      missing: { label: "not registered", reason: `harness ${n} is not registered: its runs are refused` },
    };
  const why = host.get(n) ?? null;
  return {
    name: n,
    missing: why
      ? {
          label: "not installed",
          reason: `${why}; set ${n}.binary in duskfleet.yaml or put it on PATH: its runs are refused`,
        }
      : null,
  };
}
