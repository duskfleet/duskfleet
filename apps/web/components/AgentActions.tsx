"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { type ActionResult, deleteAgentAction, unlinkAgentAction } from "@/app/agents/actions";

/**
 * Delete / unlink for user agents. Two-step confirmation inline (no browser
 * dialogs), result message shown in place. Builtins render nothing: they are
 * edited in the repo.
 */
export function AgentActions({
  id,
  source,
  linked,
}: {
  id: string;
  source: "builtin" | "user";
  linked: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState<"delete" | "unlink" | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);

  if (source !== "user") {
    return (
      <span
        className="faint"
        style={{ fontSize: "0.78rem" }}
        title={`Builtin agents live in config/agents and are versioned with the repo. To edit, unlink or delete it from here or via update_agent, move the file: mv config/agents/${id}.md data/agents/`}
      >
        builtin · read-only · move to data/agents to edit
      </span>
    );
  }

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
          <button
            type="button"
            className={`copy-btn ${confirm === "delete" ? "danger" : ""}`}
            disabled={pending}
            onClick={() => run(confirm)}
          >
            {pending ? "…" : confirm === "delete" ? "Yes, delete" : "Yes, unlink"}
          </button>
          <button type="button" className="copy-btn" disabled={pending} onClick={() => setConfirm(null)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          {linked && (
            <button
              type="button"
              className="copy-btn"
              onClick={() => setConfirm("unlink")}
              title={`Keep the agent, drop the claude_agent link to ${linked}`}
            >
              Unlink
            </button>
          )}
          <button
            type="button"
            className="copy-btn danger"
            onClick={() => setConfirm("delete")}
            title="Remove the agent file from data/agents"
          >
            Delete
          </button>
        </>
      )}
      {result && (
        <span className={result.ok ? "muted" : ""} style={{ color: result.ok ? undefined : "var(--bad)" }}>
          {result.message}
        </span>
      )}
    </span>
  );
}
