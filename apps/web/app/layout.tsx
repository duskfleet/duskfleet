import { hostname } from "node:os";
import { parseHolder } from "@duskfleet/core";
import type { Metadata } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import "./globals.css";
import { NavSettings, NavTabs } from "@/components/NavTabs";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { schedulerEnabled, schedulerLease } from "@/lib/data";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

// Self-hosted by next/font; globals.css maps these to --font-display/-sans/-mono.
// Every font-weight in globals.css and the components must be inside these ranges, never synthesized:
// Outfit 500/600/700; Geist and Geist Mono 400-600.
// Outfit 500: the muted counts next to page titles and the scheduler strip's secondary values.
// All local, not next/font/google: Google Fonts intermittently served the CI runners CSS with a font
// URL next/font cannot parse (Geist first, then Outfit), and the build failed on it. app/fonts holds
// latin variable files (OFL-1.1, app/fonts/OFL.txt): Geist as Next ships it for its dev overlay,
// Outfit as Google Fonts serves it.
const outfit = localFont({
  src: [{ path: "./fonts/outfit-latin.woff2", weight: "500 700", style: "normal" }],
  variable: "--font-outfit",
  display: "swap",
});
const geistSans = localFont({
  src: [{ path: "./fonts/geist-latin.woff2", weight: "400 600", style: "normal" }],
  variable: "--font-geist-sans",
  display: "swap",
});
const geistMono = localFont({
  src: [{ path: "./fonts/geist-mono-latin.woff2", weight: "400 600", style: "normal" }],
  variable: "--font-geist-mono",
  display: "swap",
  // next/font/local's only metric fallback is Arial; keep the monospace fallbacks of globals.css
  adjustFontFallback: false,
});

// The nav reads the scheduler lease on every request (no prerendered shell with stale data).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Duskfleet",
  description: "A fleet of agents for your own machine.",
};

/** Who ticks the scheduler right now: "off", "this process", a holder role, or "none". */
function schedulerStatus(): { label: string; title: string } {
  if (!schedulerEnabled()) return { label: "off", title: "scheduler.enabled: false in config/duskfleet.yaml" };
  const lease = schedulerLease();
  if (!lease || new Date(lease.expiresAt).getTime() <= Date.now()) {
    return { label: "none", title: "No Duskfleet process holds the scheduler lease right now" };
  }
  const holder = parseHolder(lease.holder);
  const self = holder.host === hostname() && holder.pid === process.pid;
  return {
    label: self ? "this process" : holder.role,
    title: `Lease held by ${lease.holder} (role@host:pid). Only the lease holder ticks.`,
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const scheduler = schedulerStatus();
  const version = process.env.DUSKFLEET_VERSION;
  return (
    // suppressHydrationWarning: THEME_INIT_SCRIPT may set data-theme on <html> before hydration
    <html
      lang="en"
      className={`${outfit.variable} ${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant of ours (lib/theme.ts), no user input */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <div className="shell">
          <nav className="nav" aria-label="Main">
            <Link href="/" className="brand">
              {/* public/brand/mark.svg inline, coloured by the --mark-* tokens; globals.css sets its size */}
              <svg className="mark" width={55} height={55} viewBox="0 0 110 110" fill="none" aria-hidden="true">
                <defs>
                  <linearGradient
                    id="mark-gradient"
                    x1="22"
                    y1="14.67"
                    x2="102.3"
                    y2="87.67"
                    gradientUnits="userSpaceOnUse"
                  >
                    <stop className="from" />
                    <stop className="via" offset=".55" />
                    <stop className="to" offset="1" />
                  </linearGradient>
                </defs>
                <path fill="url(#mark-gradient)" d="M22 14.67H55A40.33 40.33 0 0 1 55 95.33H22Z" />
                <path className="sail" d="M36.67 31.17V78.83H75.17Z" />
              </svg>
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
            <span className="nav-break" aria-hidden="true" />
            <NavSettings />
          </nav>
          {children}
          <footer className="footer">
            <span className="version">{version ? `duskfleet ${version}` : ""}</span>
            <ThemeSwitch />
          </footer>
        </div>
      </body>
    </html>
  );
}
