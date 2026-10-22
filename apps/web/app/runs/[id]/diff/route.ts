import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { getRun, runPatchPath } from "@/lib/data";

export const dynamic = "force-dynamic";

/** The patch of what the run changed in git, as plain text. Read-only: serves only a file under data/logs. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id)?.run;
  const patchPath = run ? runPatchPath(run) : null;
  if (!patchPath) return new Response("No diff for this run.", { status: 404 });
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(patchPath, "r");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return new Response("No diff for this run.", { status: 404 });
    return new Response(`Cannot read the diff (${code ?? "error"}).`, { status: 500 });
  }
  // The stream owns the handle and closes it at the end or on error.
  const body = Readable.toWeb(file.createReadStream()) as ReadableStream<Uint8Array>;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
