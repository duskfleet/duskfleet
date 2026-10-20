import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { getRun, runLogPath } from "@/lib/data";

export const dynamic = "force-dynamic";

/** The run's raw stream-json log, as plain text. Read-only: serves only a log under data/logs. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id)?.run;
  const logPath = run ? runLogPath(run) : null;
  if (!logPath) return new Response("No log for this run.", { status: 404 });
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(logPath, "r");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return new Response("No log for this run.", { status: 404 });
    return new Response(`Cannot read the log (${code ?? "error"}).`, { status: 500 });
  }
  // The stream owns the handle and closes it at the end or on error.
  const body = Readable.toWeb(file.createReadStream()) as ReadableStream<Uint8Array>;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
