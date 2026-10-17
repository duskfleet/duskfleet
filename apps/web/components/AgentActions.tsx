"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteAgentAction, unlinkAgentAction, type ActionResult } from "@/app/agents/actions";

/**
 * Delete / unlink for user agents. Two-step confirmation inline (no browser
 * dialogs), result message shown in place. Builtins render nothing: they are
 * edited in the repo.
 */
export function AgentActions({ id, source, linked, overridesBuiltin = false }: { id: string; source: "builtin" | "user"; linked: string | null; overridesBuiltin?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState<"delete" | "unlink" | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);

  // Builtins are edited in the repo; the card's source tag explains it.
  if (source !== "user") return null;

  const run = (kind: "delete" | "unlink") =>
    start(async () => {
      const r = kind === "delete" ? await deleteAgentAction(id) : await unlinkAgentAction(id);
      setResult(r);
      setConfirm(null);
      if (r.ok) router.refresh();
    });

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap", fontSize: "0.8rem" }}>
      {confirm ? (
        <>
          <span className="muted">{confirm === "delete" ? `Delete "${id}"?` : `Remove link to ${linked}?`}</span>
          <button type="button" className={`copy-btn ${confirm === "delete" ? "danger" : ""}`} disabled={pending} onClick={() => run(confirm)}>
            {pending ? "…" : confirm === "delete" ? "Yes, delete" : "Yes, unlink"}
          </button>
          <button type="button" className="copy-btn" disabled={pending} onClick={() => setConfirm(null)}>Cancel</button>
        </>
      ) : (
        <>
          {linked && (
            <button type="button" className="copy-btn" onClick={() => setConfirm("unlink")} title={`Keep the agent, drop the claude_agent link to ${linked}`}>
              Unlink
            </button>
          )}
          <button
            type="button"
            // Deleting an override only reactivates the builtin: not destructive, so not red.
            className={`copy-btn ${overridesBuiltin ? "" : "danger"}`}
            onClick={() => setConfirm("delete")}
            title={overridesBuiltin ? "Remove the user file from data/agents: the builtin becomes active again" : "Remove the agent file from data/agents"}
          >
            {overridesBuiltin ? "Delete user file" : "Delete"}
          </button>
        </>
      )}
      {result && (
        <span className={result.ok ? "muted" : ""} style={{ color: result.ok ? undefined : "var(--bad)" }}>{result.message}</span>
      )}
    </span>
  );
}
