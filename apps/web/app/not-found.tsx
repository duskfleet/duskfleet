import Link from "next/link";

export const metadata = { title: "Not found · Duskfleet" };

export default function NotFound() {
  return (
    <div className="empty" style={{ marginTop: 40 }}>
      <div style={{ fontSize: "1.1rem", fontWeight: 600, color: "var(--text)" }}>This page does not exist.</div>
      <div style={{ marginTop: 6 }}>
        Go back to <Link href="/">runs</Link>, <Link href="/agents">agents</Link> or{" "}
        <Link href="/schedules">schedules</Link>.
      </div>
    </div>
  );
}
