import type { AttentionBadge as Badge } from "@/lib/attention";

/**
 * DS-28 `Nav/AttentionBadge`: the number of attention items (causes, never runs) on the Attention
 * tab. Coral (tone bad) for a login/quota error or a spent hard-stop budget, amber otherwise;
 * nothing at 0. The tint sits on a `--panel` underlay so the count keeps 4.5:1 on the active tab.
 */
export function AttentionBadge({ badge }: { badge: Badge | null }) {
  if (!badge || badge.count === 0) return null;
  const what = badge.count === 1 ? "1 item needs you" : `${badge.count} items need you`;
  return (
    <span className={`nav-badge ${badge.tone}`} title={what}>
      <span aria-hidden="true">{badge.count > 99 ? "99+" : badge.count}</span>
      <span className="sr-only">{what}</span>
    </span>
  );
}
