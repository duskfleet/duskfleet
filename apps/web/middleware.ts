import { type NextRequest, NextResponse } from "next/server";
import { DEFAULT_PORT, isAllowedHost } from "./lib/host";

// Localhost only, no auth: refuse any Host that is not this server on loopback (DNS rebinding).
export function middleware(request: NextRequest) {
  if (isAllowedHost(request.headers.get("host"), process.env.PORT ?? DEFAULT_PORT)) return NextResponse.next();
  return new NextResponse("Forbidden: the dashboard only answers on localhost.\n", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

// Node.js runtime: `next dev` / `next start` set process.env.PORT from --port.
export const config = { runtime: "nodejs" };
