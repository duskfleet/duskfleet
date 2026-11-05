"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { AttentionBadge as Badge } from "@/lib/attention";
import { AttentionBadge } from "./AttentionBadge";

const TABS: Array<{ href: string; label: string; match: (p: string) => boolean }> = [
  // DS-28: Attention first at every width; the tab stays at 0, only its badge goes
  { href: "/attention", label: "Attention", match: (p) => p.startsWith("/attention") },
  {
    href: "/",
    label: "Runs",
    match: (p) => p === "/" || p.startsWith("/runs") || p.startsWith("/trends") || p.startsWith("/costs"),
  },
  { href: "/agents", label: "Agents", match: (p) => p.startsWith("/agents") },
  { href: "/schedules", label: "Schedules", match: (p) => p.startsWith("/schedules") },
  { href: "/mcp", label: "MCP", match: (p) => p.startsWith("/mcp") },
];

/** Top navigation with the current section marked (aria-current + style); `attention` = the Attention tab's badge. */
export function NavTabs({ attention = null }: { attention?: Badge | null }) {
  const pathname = usePathname() ?? "/";
  return (
    <>
      {TABS.map((t) => {
        const active = t.match(pathname);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`tab ${active ? "active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            {t.label}
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
