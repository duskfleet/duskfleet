/**
 * `doctor`'s harness entry (issue #445): every registered harness with its binary and version (or
 * why it could not be read), the agents that run on it, and the agents whose `harness:` names no
 * registered executor. A missing binary of a harness no agent uses is not a problem.
 */
import { type DuskFleetConfig, type HarnessRegistry, harnessOf, SHIPPED_HARNESSES } from "@duskfleet/core";
import type { HarnessReport } from "./render/index.js";

export async function harnessReport(
  app: { harnesses: HarnessRegistry; config: DuskFleetConfig },
  /** Version (or error) of the default harness when the caller already asked it, so it is not asked twice. */
  claude?: { version: string | null; error: string | null },
): Promise<HarnessReport> {
  const agents = [...app.config.agents.values()];
  const registered: HarnessReport["registered"] = [];
  for (const name of app.harnesses.names()) {
    const executor = app.harnesses.get(name)!;
    let version: string | null = null;
    let error: string | null = null;
    if (name === "claude" && claude) ({ version, error } = claude);
    else {
      try {
        version = await executor.version();
      } catch (err) {
        error = String(err);
      }
    }
    registered.push({
      name,
      binary: executor.binary,
      version,
      error,
      agents: agents.filter((a) => harnessOf(a) === name).map((a) => a.id),
    });
  }
  const known = new Set(app.harnesses.names());
  const unknown = agents.filter((a) => !known.has(harnessOf(a))).map((a) => ({ agentId: a.id, harness: harnessOf(a) }));
  // A harness that ships but whose CLI was not found at start-up (bootstrap registers only what resolves).
  const notInstalled = SHIPPED_HARNESSES.filter((name) => !known.has(name));
  return { registered, unknown, notInstalled };
}
