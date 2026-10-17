"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Re-fetches the current Server Component tree on an interval and shows a
 * pause toggle in the nav (portal into #nav-meta). Only pages with live data
 * render it: the runs list, and a run detail while the run is in progress.
 * Static pages (agents, schedules, MCP) do not refresh at all.
 */
export function AutoRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setSlot(document.getElementById("nav-meta"));
  }, []);

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => {
      // Do not yank the page while the user is selecting text.
      if (window.getSelection()?.toString()) return;
      router.refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs, paused]);

  const seconds = Math.round(intervalMs / 1000);
  const button = (
    <button
      type="button"
      className={`live-btn ${paused ? "paused" : ""}`}
      onClick={() => setPaused((p) => !p)}
      aria-pressed={paused}
      title={paused ? "Auto-refresh paused. Click to resume." : `This page reloads its data every ${seconds}s. Click to pause while reading.`}
    >
      <span className="pulse" aria-hidden="true" />
      {paused ? "paused" : `live · ${seconds} s`}
    </button>
  );
  return slot ? createPortal(button, slot) : null;
}
