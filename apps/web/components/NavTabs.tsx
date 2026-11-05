"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS: Array<{ href: string; label: string; match: (p: string) => boolean }> = [
  {
    href: "/",
    label: "Runs",
    match: (p) => p === "/" || p.startsWith("/runs") || p.startsWith("/trends") || p.startsWith("/costs"),
  },
  { href: "/agents", label: "Agents", match: (p) => p.startsWith("/agents") },
  { href: "/schedules", label: "Schedules", match: (p) => p.startsWith("/schedules") },
  { href: "/mcp", label: "MCP", match: (p) => p.startsWith("/mcp") },
];

/**
 * Top navigation with the current section marked (aria-current + style). DS-30: the Runs tab
 * carries a badge with the number of runs running now (`running`, read by the layout on every
 * request); no badge, not a "0", when nothing runs.
 */
export function NavTabs({ running = 0 }: { running?: number }) {
  const pathname = usePathname() ?? "/";
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
                <span className="nav-badge" aria-hidden="true">
                  {running}
                </span>
                <span className="sr-only">, {running} running</span>
              </>
            ) : null}
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
