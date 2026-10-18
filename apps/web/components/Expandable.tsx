"use client";

import { type ReactNode, useState } from "react";

/**
 * Caps tall content (a long result) at `maxHeight` with a fade and a
 * "Show all" toggle. Renders fully expanded when JS is off? No: the cap is
 * applied by class, so without JS the content is simply visible in full.
 */
export function Expandable({
  children,
  maxHeight = "70vh",
  label = "Show full result",
}: {
  children: ReactNode;
  maxHeight?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`expandable ${open ? "open" : ""}`}
      style={open ? undefined : ({ "--max-h": maxHeight } as React.CSSProperties)}
    >
      <div className="expandable-body">{children}</div>
      {!open && (
        <div className="expandable-foot">
          <button type="button" className="copy-btn" onClick={() => setOpen(true)}>
            {label}
          </button>
        </div>
      )}
    </div>
  );
}
