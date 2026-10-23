import Link from "next/link";

export const metadata = { title: "Run not found · Duskfleet" };

export default function RunNotFound() {
  return (
    <>
      <div className="crumbs" style={{ marginBottom: 14, color: "var(--muted)", fontSize: "0.9rem" }}>
        <Link href="/">Runs</Link> <span className="faint">/</span> <span>unknown run</span>
      </div>
      <div className="empty">
        <div style={{ fontSize: "1.1rem", fontWeight: 600, color: "var(--text)" }}>No run with this id.</div>
        <div style={{ marginTop: 6 }}>
          It may have been recorded in another database, or the id was mistyped.{" "}
          <Link href="/">Back to recent runs</Link>.
        </div>
      </div>
    </>
  );
}
