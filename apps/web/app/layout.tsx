import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Outfit } from "next/font/google";
import Link from "next/link";
import { hostname } from "node:os";
import { parseHolder } from "@duskfleet/core";
import "./globals.css";
import { NavTabs } from "@/components/NavTabs";
import { schedulerEnabled, schedulerLease } from "@/lib/data";

// Self-hosted at build time by next/font; globals.css maps these to --font-display/-sans/-mono.
const outfit = Outfit({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-outfit", display: "swap" });
// 600 on top of the brand's 400/500: the dashboard bolds labels and badges, which would otherwise be synthesized.
const plexSans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-sans", display: "swap" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono", display: "swap" });

// The nav reads the scheduler lease on every request (no prerendered shell with stale data).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "DuskFleet",
  description: "Agents and runs dashboard",
};

/** Who ticks the scheduler right now: "off", "this process", a holder role, or "none". */
function schedulerStatus(): { label: string; title: string } {
  if (!schedulerEnabled()) return { label: "off", title: "scheduler.enabled: false in config/duskfleet.yaml" };
  const lease = schedulerLease();
  if (!lease || new Date(lease.expiresAt).getTime() <= Date.now()) {
    return { label: "none", title: "No DuskFleet process holds the scheduler lease right now" };
  }
  const holder = parseHolder(lease.holder);
  const self = holder.host === hostname() && holder.pid === process.pid;
  return { label: self ? "this process" : holder.role, title: `Lease held by ${lease.holder} (role@host:pid). Only the lease holder ticks.` };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const scheduler = schedulerStatus();
  return (
    <html lang="en" className={`${outfit.variable} ${plexSans.variable} ${plexMono.variable}`}>
      <body>
        <div className="shell">
          <nav className="nav" aria-label="Main">
            <Link href="/" className="brand">
              <img src="/brand/mark.svg" width={26} height={26} alt="" />
              <span className="wordmark">
                dusk<span className="fleet">fleet</span>
              </span>
            </Link>
            <NavTabs />
            <span className="meta">
              <Link href="/schedules" className="scheduler" title={scheduler.title}>
                scheduler: {scheduler.label}
              </Link>
              {/* Pages with live data mount <AutoRefresh> here (portal). */}
              <span id="nav-meta" />
            </span>
          </nav>
          {children}
        </div>
      </body>
    </html>
  );
}
