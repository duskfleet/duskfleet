/**
 * Claude Code's native sandbox for an agent's Bash commands (agent frontmatter `sandbox: true`).
 *
 * Duskfleet only turns it on per run and reports what it blocked; the sandbox itself is Claude
 * Code's (Seatbelt on macOS, bubblewrap on Linux). Verified with real haiku runs on Claude Code
 * 2.1.325, macOS, with the same argv as `buildArgv` (issue #447):
 *
 *   - `--settings '<json>'` with `sandbox.enabled: true` turns it on next to
 *     `--setting-sources project,local`, and wins over the project's `.claude/settings.json` in
 *     both directions. An agent without the switch therefore gets no `--settings` at all, so a
 *     project that enables the sandbox itself keeps it.
 *   - `--add-dir` directories stay writable inside the sandbox; every other directory outside the
 *     project is not (`EPERM`).
 *   - Network goes through a local proxy that allows only `sandbox.network.allowedDomains`
 *     (exact host names verified). Tools that ignore the proxy environment get no DNS at all,
 *     even for a listed host (Node's built-in `fetch`: `ENOTFOUND`).
 *   - A blocked connection is marked in the tool result's `tool_result_meta[].remedy.kind ==
 *     "sandbox_violation"` (stream-json.ts counts it). A blocked file write has no marker: it is an
 *     ordinary failed command and cannot be told apart from one.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { effectivePath } from "./search-path.js";

/** `remedy.kind` of a tool result the sandbox blocked (network), verified 2026-11-16. */
export const SANDBOX_VIOLATION_KIND = "sandbox_violation";

/**
 * One `sandbox_allowed_domains` entry: an exact host name, lowercase letters, digits, `-` and `.`
 * (no scheme, port, path or wildcard: only exact hosts were verified).
 */
export const SANDBOX_DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
export const SANDBOX_DOMAIN_MESSAGE =
  "sandbox_allowed_domains entries are exact host names such as api.github.com (lowercase, no scheme, port, path or wildcard)";

/**
 * The `--settings` value of a sandboxed run: sandbox on, no unsandboxed fallback, the listed hosts
 * reachable. `weakerNetworkIsolation` adds `enableWeakerNetworkIsolation: true` (agent frontmatter
 * `sandbox_weaker_network_isolation`, issue #449): on macOS it lets Go tools such as `gh` verify TLS
 * inside the sandbox (verified with real haiku runs on 2.1.325: `x509: OSStatus -26276` without it),
 * at the cost of a weaker network isolation for every command of the run. Without the flag the
 * value is exactly what it was before the option existed.
 */
export function sandboxSettings(
  allowedDomains: readonly string[],
  options: { weakerNetworkIsolation?: boolean } = {},
): string {
  const sandbox: Record<string, unknown> = { enabled: true, allowUnsandboxedCommands: false };
  if (options.weakerNetworkIsolation === true) sandbox["enableWeakerNetworkIsolation"] = true;
  if (allowedDomains.length > 0) sandbox["network"] = { allowedDomains: [...new Set(allowedDomains)] };
  return JSON.stringify({ sandbox });
}

export interface SandboxSupport {
  available: boolean;
  platform: NodeJS.Platform;
  /** What the sandbox runs on here, or why it cannot run. */
  detail: string;
  /** Programs the platform needs that were not found (Linux: bwrap, socat). */
  missing: string[];
}

/** Seatbelt's front end, part of every macOS install. */
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** What Claude Code's sandbox needs on Linux: bubblewrap, and socat for the network proxy. */
const LINUX_PROGRAMS = ["bwrap", "socat"] as const;

/**
 * Whether Claude Code's sandbox can run on this host. macOS: Seatbelt (`sandbox-exec`). Linux:
 * `bwrap` and `socat` on the PATH. Anything else (Windows): no native sandbox. A run of a
 * sandboxed agent on a host without it is refused before spawning, never run unsandboxed.
 */
export function sandboxSupport(
  platform: NodeJS.Platform = process.platform,
  pathEnv: string | undefined = process.env["PATH"],
  exists: (file: string) => boolean = existsSync,
): SandboxSupport {
  if (platform === "darwin") {
    return exists(SANDBOX_EXEC)
      ? { available: true, platform, detail: "Seatbelt (sandbox-exec)", missing: [] }
      : { available: false, platform, detail: `${SANDBOX_EXEC} not found`, missing: ["sandbox-exec"] };
  }
  if (platform === "linux") {
    const dirs = effectivePath(pathEnv, platform).split(path.delimiter).filter(Boolean);
    const missing = LINUX_PROGRAMS.filter((p) => !dirs.some((d) => exists(path.join(d, p))));
    return missing.length === 0
      ? { available: true, platform, detail: "bubblewrap (bwrap, socat)", missing: [] }
      : {
          available: false,
          platform,
          detail: `${missing.join(" and ")} not found on PATH (install bubblewrap and socat)`,
          missing: [...missing],
        };
  }
  return { available: false, platform, detail: `Claude Code has no native sandbox on ${platform}`, missing: [] };
}
