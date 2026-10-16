import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Outfit } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { NavTabs } from "@/components/NavTabs";

// Self-hosted at build time by next/font; globals.css maps these to --font-display/-sans/-mono.
const outfit = Outfit({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-outfit", display: "swap" });
// 600 on top of the brand's 400/500: the dashboard bolds labels and badges, which would otherwise be synthesized.
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
  display: "swap",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "DuskFleet",
  description: "Agents and runs dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${plexSans.variable} ${plexMono.variable}`}>
      <body>
        <div className="shell">
          <nav className="nav" aria-label="Main">
            <Link href="/" className="brand">
              <span className="dot" />
              DuskFleet
            </Link>
            <NavTabs />
            {/* Pages with live data mount <AutoRefresh> here (portal). */}
            <span className="meta" id="nav-meta" />
          </nav>
          {children}
        </div>
      </body>
    </html>
  );
}
