/**
 * DS-21 `Agent/Spark`: one bar per UTC day, height proportional to the day's value (max 26 px).
 * Decorative: the numbers next to it carry the information. Past days faint; today `live` (a run
 * in progress, run colour) or `accent`, else faint.
 */
export function Spark({
  values,
  today = "",
  small = false,
}: {
  values: number[];
  today?: "" | "live" | "accent";
  small?: boolean;
}) {
  const max = Math.max(...values, 0);
  return (
    <span className={`spark ${small ? "small" : ""}`} aria-hidden="true">
      {values.map((v, i) => {
        const last = i === values.length - 1;
        const h = max > 0 ? Math.max(2, Math.round((v / max) * 26)) : 2;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: one bar per day, the index is the day
          <span key={i} className={`spark-bar ${last ? `today ${today}` : ""}`} style={{ height: h }} />
        );
      })}
    </span>
  );
}
