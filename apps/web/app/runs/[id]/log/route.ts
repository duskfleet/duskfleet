import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { getRun } from "@/lib/data";

export const dynamic = "force-dynamic";

/** The run's raw stream-json log, as plain text. Read-only: serves only the path recorded on the run. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const logPath = getRun(id)?.run.logPath;
  if (!logPath || !existsSync(logPath)) return new Response("No log for this run.", { status: 404 });
  const body = Readable.toWeb(createReadStream(logPath)) as ReadableStream<Uint8Array>;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
