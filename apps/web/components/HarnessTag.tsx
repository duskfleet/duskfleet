import type { HarnessInfo } from "@/lib/harness";

/**
 * The agent CLI an agent or a run is on, as text (issue #478): the harness name in mono, muted.
 * A harness this host cannot start is amber, says so after the name and gives the reason on hover.
 */
export function HarnessTag({ info }: { info: HarnessInfo }) {
  if (info.missing)
    return (
      <span className="harness warn-text" title={info.missing.reason}>
        {info.name} · {info.missing.label}
      </span>
    );
  return (
    <span className="harness" title={`Runs on the ${info.name} agent CLI (harness)`}>
      {info.name}
    </span>
  );
}
