import { CopyButton } from "@/components/CopyButton";
import { fmtBytes } from "@/lib/format";

/** How many hex digits of the SHA-256 are shown; the full hash is in the title and the Copy button. */
const SHA_SHOWN = 12;

/**
 * Rows of the run page's Technical details list (`<dl className="kv">`): the raw log's size,
 * SHA-256 and whether the writer stopped at `claude.max_log_bytes`. All three are filled when
 * the run ends; a running run and rows older than migration 24 show "–".
 */
export function LogFacts({
  logBytes,
  logSha256,
  logTruncated,
}: {
  logBytes: number | null | undefined;
  logSha256: string | null | undefined;
  logTruncated: boolean | null | undefined;
}) {
  return (
    <>
      <dt>log size</dt>
      <dd className="num kv-inline">
        <span title={logBytes == null ? undefined : `${logBytes.toLocaleString()} bytes`}>{fmtBytes(logBytes)}</span>
        {logTruncated && (
          <span
            className="badge attention"
            title="The log reached claude.max_log_bytes and stops at a duskfleet_log_truncated line; the events in the database are complete"
          >
            truncated
          </span>
        )}
      </dd>
      <dt>log sha256</dt>
      <dd className="mono kv-inline">
        {logSha256 ? (
          <>
            <span title={logSha256}>{`${logSha256.slice(0, SHA_SHOWN)}…`}</span>
            <CopyButton text={logSha256} />
          </>
        ) : (
          "–"
        )}
      </dd>
    </>
  );
}
