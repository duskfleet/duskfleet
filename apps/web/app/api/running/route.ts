import { runningCount } from "@/lib/data";

export const dynamic = "force-dynamic";

/** The nav's Runs badge count (DS-30), polled by NavTabs on every page. Read-only. */
export function GET() {
  return Response.json({ running: runningCount() }, { headers: { "cache-control": "no-store" } });
}
