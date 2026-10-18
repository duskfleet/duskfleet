"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS: Array<{ href: string; label: string; match: (p: string) => boolean }> = [
  { href: "/", label: "Runs", match: (p) => p === "/" || p.startsWith("/runs") },
  { href: "/agents", label: "Agents", match: (p) => p.startsWith("/agents") },
  { href: "/schedules", label: "Schedules", match: (p) => p.startsWith("/schedules") },
  { href: "/mcp", label: "MCP", match: (p) => p.startsWith("/mcp") },
];

/** Top navigation with the current section marked (aria-current + style). */
export function NavTabs() {
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
          </Link>
        );
      })}
    </>
  );
}
