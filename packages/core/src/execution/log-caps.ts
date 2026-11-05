/**
 * Bounds on what a run writes (claude.max_event_bytes, claude.max_log_bytes) and the
 * metadata of the raw log (size, SHA-256) recorded when the run ends.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  type WriteStream,
} from "node:fs";
import { dirname } from "node:path";

/** 64 KiB per `run_events` payload. */
export const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;
/** 50 MiB per raw JSONL log. */
export const DEFAULT_MAX_LOG_BYTES = 50 * 1024 * 1024;

/** Last line of a log the writer stopped at its cap. */
export const LOG_TRUNCATED_TYPE = "duskfleet_log_truncated";
export const LOG_TRUNCATED_LINE = `{"type":"${LOG_TRUNCATED_TYPE}","bytes_dropped_from_here":true}\n`;

const utf8Bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** What a cut string ends with: how many UTF-8 bytes were dropped. */
export function truncationMarker(droppedBytes: number): string {
  return `…[truncated ${droppedBytes} bytes]`;
}

/**
 * The JSON stored for one event, at most `maxBytes` long. Under the cap: `JSON.stringify(payload)`.
 * Over it: the envelope stays (keys, numbers, short strings such as type, ids and tool names) and
 * the longest strings are cut, each ending with `truncationMarker`, until it fits; the payload
 * gets `truncated: true`. When cutting strings is not enough, the largest nested arrays and objects
 * become `{ truncated: true, bytes }` stubs, so the scalar keys survive. A payload that is not an
 * object, or whose scalars alone pass the cap, is stored as `{ truncated: true, bytes, preview }`.
 */
export function capEventJson(payload: unknown, maxBytes: number): string {
  const json = JSON.stringify(payload);
  if (json === undefined || utf8Bytes(json) <= maxBytes) return json;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const copy = JSON.parse(json) as Record<string, unknown>;
    copy["truncated"] = true;
    for (let i = 0; i < 64; i++) {
      const out = JSON.stringify(copy);
      const over = utf8Bytes(out) - maxBytes;
      if (over <= 0) return out;
      const leaf = longestString(copy);
      if (!leaf) break;
      const value = leaf.holder[leaf.key] as string;
      const encoded = utf8Bytes(JSON.stringify(value));
      // Room for the marker, then keep the share of characters that leaves the JSON under the cap.
      const target = Math.max(0, encoded - over - 48);
      if (target >= encoded) break;
      const kept = cutChars(value, Math.floor((value.length * target) / encoded));
      if (kept.length >= value.length) break;
      leaf.holder[leaf.key] = kept + truncationMarker(utf8Bytes(value) - utf8Bytes(kept));
    }
    // No long string left to cut (a big array of short paths, say): stub the largest arrays and
    // objects so the scalar envelope keys (type, filesChanged, name) survive.
    const stubs = new WeakSet<object>();
    for (let i = 0; i < 256; i++) {
      const out = JSON.stringify(copy);
      if (utf8Bytes(out) <= maxBytes) return out;
      const big = largestContainer(copy, stubs);
      if (!big) break;
      const stub = { truncated: true, bytes: big.bytes };
      stubs.add(stub);
      big.holder[big.key] = stub;
    }
  }
  const bytes = utf8Bytes(json);
  const fallback = (preview: string) => JSON.stringify({ truncated: true, bytes, preview });
  // The preview is cut until the whole object fits (escapes can make the JSON longer than the text).
  let keep = Math.max(0, maxBytes - 128);
  let out = fallback(cutChars(json, keep) + truncationMarker(bytes - utf8Bytes(cutChars(json, keep))));
  while (utf8Bytes(out) > maxBytes && keep > 0) {
    keep = Math.floor(keep / 2);
    const kept = cutChars(json, keep);
    out = fallback(kept + truncationMarker(bytes - utf8Bytes(kept)));
  }
  return out;
}

/** The first `n` characters, never splitting a surrogate pair. */
function cutChars(s: string, n: number): string {
  if (n >= s.length) return s;
  let end = Math.max(0, n);
  const code = s.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

type Holder = Record<string, unknown> | unknown[];

/** The longest string anywhere in the payload (worth cutting: over 64 characters), with what holds it. */
function longestString(root: Holder): { holder: Record<string | number, unknown>; key: string | number } | null {
  let best: { holder: Record<string | number, unknown>; key: string | number; length: number } | null = null;
  const visit = (node: Holder) => {
    const entries: Array<[string | number, unknown]> = Array.isArray(node)
      ? node.map((v, i) => [i, v])
      : Object.entries(node);
    for (const [key, value] of entries) {
      if (typeof value === "string") {
        if (value.length > 64 && (!best || value.length > best.length))
          best = { holder: node as Record<string | number, unknown>, key, length: value.length };
      } else if (typeof value === "object" && value !== null) {
        visit(value as Holder);
      }
    }
  };
  visit(root);
  return best;
}

/** The largest array or object below the root (by JSON bytes), stubs excluded, with what holds it. */
function largestContainer(
  root: Holder,
  stubs: WeakSet<object>,
): { holder: Record<string | number, unknown>; key: string | number; bytes: number } | null {
  let best: { holder: Record<string | number, unknown>; key: string | number; bytes: number } | null = null;
  const visit = (node: Holder) => {
    const entries: Array<[string | number, unknown]> = Array.isArray(node)
      ? node.map((v, i) => [i, v])
      : Object.entries(node);
    for (const [key, value] of entries) {
      if (typeof value !== "object" || value === null || stubs.has(value)) continue;
      const bytes = utf8Bytes(JSON.stringify(value));
      if (!best || bytes > best.bytes) best = { holder: node as Record<string | number, unknown>, key, bytes };
      visit(value as Holder);
    }
  };
  visit(root);
  return best;
}

/**
 * Append-only writer of a run's raw log that stops at `maxBytes`. The line that would cross the
 * cap is replaced by `LOG_TRUNCATED_LINE` and nothing more is written; `truncated` says so. A file
 * that already ends with the marker when opened (an earlier pass of the same run stopped, at any
 * size) is not written again; one at or over its cap without the marker gets it once.
 */
export class CappedLogWriter {
  private readonly stream: WriteStream;
  private written: number;
  private stopped = false;

  constructor(
    readonly path: string,
    private readonly maxBytes: number,
    onError: (err: Error) => void,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.written = existsSync(path) ? statSync(path).size : 0;
    this.stream = createWriteStream(path, { flags: "a" });
    this.stream.on("error", onError);
    // The writer stops at the line that would cross the cap, so a capped file can end with the
    // marker below the cap: the marker alone says the log is closed.
    if (this.written > 0 && endsWithMarker(path, this.written)) {
      this.stopped = true;
    } else if (this.written >= maxBytes) {
      this.stopped = true;
      this.stream.write(LOG_TRUNCATED_LINE);
    }
  }

  /** True once the cap was reached: the log ends with the marker line. */
  get truncated(): boolean {
    return this.stopped;
  }

  write(text: string): void {
    if (this.stopped) return;
    const bytes = utf8Bytes(text);
    if (this.written + bytes > this.maxBytes) {
      this.stopped = true;
      this.stream.write(LOG_TRUNCATED_LINE);
      return;
    }
    this.written += bytes;
    this.stream.write(text);
  }

  /** Close the file; resolves once everything written is on disk (or the stream failed). */
  end(): Promise<void> {
    return new Promise((resolve) => {
      if (this.stream.closed || this.stream.destroyed) {
        resolve();
        return;
      }
      this.stream.once("close", () => resolve());
      this.stream.once("error", () => resolve());
      this.stream.end();
    });
  }
}

function endsWithMarker(file: string, size: number): boolean {
  const len = LOG_TRUNCATED_LINE.length;
  if (size < len) return false;
  const buf = Buffer.alloc(len);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf8") === LOG_TRUNCATED_LINE;
}

export interface LogMetadata {
  bytes: number;
  sha256: string;
}

/** Size and SHA-256 of the log as written (read in 1 MiB chunks); null when there is no file. */
export function logMetadata(file: string | null): LogMetadata | null {
  if (!file || !existsSync(file)) return null;
  const hash = createHash("sha256");
  const buf = Buffer.alloc(1024 * 1024);
  let bytes = 0;
  const fd = openSync(file, "r");
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      bytes += n;
    }
  } finally {
    closeSync(fd);
  }
  return { bytes, sha256: hash.digest("hex") };
}
