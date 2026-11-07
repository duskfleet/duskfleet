"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { AttentionBadge as Badge } from "@/lib/attention";
import { parseRunningCount, RUNNING_POLL_MS } from "@/lib/running";
import { AttentionBadge } from "./AttentionBadge";

const TABS: Array<{ href: string; label: string; match: (p: string) => boolean }> = [
  {
    href: "/",
    label: "Runs",
    match: (p) => p === "/" || p.startsWith("/runs") || p.startsWith("/trends") || p.startsWith("/costs"),
  },
  { href: "/agents", label: "Agents", match: (p) => p.startsWith("/agents") },
  { href: "/schedules", label: "Schedules", match: (p) => p.startsWith("/schedules") },
  { href: "/mcp", label: "MCP", match: (p) => p.startsWith("/mcp") },
  // DS-28: Alerts (the Attention page) after MCP at 1280 (the frames), first in the wrapped tab row at 390 so its
  // badge never wraps out of view (CSS order); the tab stays at 0, only its badge goes
  { href: "/attention", label: "Alerts", match: (p) => p.startsWith("/attention") },
];

/**
 * Top navigation with the current section marked (aria-current + style); `attention` = the
 * Alerts tab's badge. DS-30: the Runs tab carries a badge with the number of runs running
 * now; no badge, not a "0", when nothing runs. `running` is the layout's count at its last
 * render. The layout is not re-rendered on a client-side navigation, so while mounted the tabs
 * re-read GET /api/running every RUNNING_POLL_MS and on every pathname change (skipped while
 * the tab is hidden).
 */
export function NavTabs({ running: initial = 0, attention = null }: { running?: number; attention?: Badge | null }) {
  const pathname = usePathname() ?? "/";
  const [running, setRunning] = useState(initial);

  // A layout re-render (full load, router.refresh() from AutoRefresh) brings a fresher count.
  useEffect(() => setRunning(initial), [initial]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname on purpose, re-read the count on every client-side navigation
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch("/api/running", { cache: "no-store" });
        const n = res.ok ? parseRunningCount(await res.json()) : null;
        if (alive && n !== null) setRunning(n);
      } catch {
        // Server gone (dev restart): keep the last count, the next tick retries.
      }
    };
    void poll();
    const id = setInterval(poll, RUNNING_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pathname]);

  return (
    <>
      {TABS.map((t) => {
        const active = t.match(pathname);
        const badge = t.label === "Runs" && running > 0;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`tab ${active ? "active" : ""}${badge ? " has-badge" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            {t.label}
            {badge ? (
              <>
                <span className="run-badge" aria-hidden="true">
                  {running}
                </span>
                <span className="sr-only">, {running} running</span>
              </>
            ) : null}
            {t.href === "/attention" && <AttentionBadge badge={attention} />}
          </Link>
        );
      })}
    </>
  );
}

/** DS-10: the Settings entry at the right end of the nav, gear + label (icon only, 44 px target, at 390). */
export function NavSettings() {
  const active = (usePathname() ?? "/").startsWith("/settings");
  return (
    <Link
      href="/settings"
      className={`tab nav-settings ${active ? "active" : ""}`}
      aria-current={active ? "page" : undefined}
      aria-label="Settings"
    >
      <svg
        width={16}
        height={16}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="2" />
        <path d="M6.9 1.5h2.2l.4 1.7 1.2.7 1.7-.5 1.1 1.9-1.3 1.2v1.4l1.3 1.2-1.1 1.9-1.7-.5-1.2.7-.4 1.7H6.9l-.4-1.7-1.2-.7-1.7.5-1.1-1.9 1.3-1.2V7.3L2.5 6.1l1.1-1.9 1.7.5 1.2-.7Z" />
      </svg>
      <span className="label">Settings</span>
    </Link>
  );
}
