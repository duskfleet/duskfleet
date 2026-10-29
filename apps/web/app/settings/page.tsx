import { readFileSync } from "node:fs";
import path from "node:path";
import { type EditableGlobalKey, type GlobalValue, readGlobalFile } from "@duskfleet/core";
import { AppearanceSection, ConfigSection, DangerZone } from "@/components/Settings";
import { TocSpy } from "@/components/TocSpy";
import { config, services } from "@/lib/data";
import { fmtTime } from "@/lib/format";
import { SECTIONS, SETTINGS_MARKER } from "@/lib/settings";

export const dynamic = "force-dynamic";

export const metadata = { title: "Settings · Duskfleet" };

/** True when the dashboard's own last write left the file with this mtime. */
function writtenHere(dataDir: string, modifiedAt: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(path.join(dataDir, SETTINGS_MARKER), "utf8")) as { modifiedAt?: string };
    return marker.modifiedAt === modifiedAt;
  } catch {
    return false;
  }
}

export default function SettingsPage() {
  const cfg = config();
  const file = readGlobalFile(services().configDir);
  const values = {} as Record<EditableGlobalKey, GlobalValue>;
  for (const s of SECTIONS) for (const f of s.fields) values[f.key] = file.values[f.key] ?? f.default;
  const here = writtenHere(cfg.dataDir, file.modifiedAt);
  const agents = [...cfg.agents.keys()].sort();

  const active = services()
    .schedules.list()
    .filter((s) => s.enabled);
  const next = active.filter((s) => s.nextRunAt).sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!))[0];

  const toc = [{ id: "appearance", title: "Appearance" }, ...SECTIONS, { id: "danger", title: "Danger zone" }];

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
        <span className="note">
          Runtime settings of this DuskFleet install. Agents, schedules and budgets have their own pages.
        </span>
      </div>

      <div className="card settings-source">
        <span className="source-file">
          <span className="source-label">Source</span> <code>config/duskfleet.yaml</code>
        </span>
        <span className="source-meta">
          last changed <time dateTime={file.modifiedAt}>{fmtTime(file.modifiedAt)}</time>
          {here ? ", from this dashboard" : ", outside the dashboard (hand edit)"}. Values are re-read on every run.
        </span>
        <span className="source-legend">
          <span className="marker next">→ Next run</span>
          <span className="marker restart">↻ Restart MCP host</span>
        </span>
      </div>

      <div className="docs settings">
        <nav className="toc" aria-label="On this page">
          <div className="group">On this page</div>
          {toc.map((t) => (
            <a key={t.id} href={`#${t.id}`} className="plain">
              {t.title}
            </a>
          ))}
        </nav>
        <TocSpy selector=".toc" />

        <div className="docs-main settings-main">
          <AppearanceSection />
          {SECTIONS.map((s) => (
            <ConfigSection
              key={s.id}
              id={s.id}
              values={Object.fromEntries(s.fields.map((f) => [f.key, values[f.key]]))}
              agents={agents}
              schedulerEnabled={cfg.scheduler.enabled}
            />
          ))}
          <DangerZone
            enabled={cfg.scheduler.enabled}
            activeSchedules={active.length}
            next={next ? { at: next.nextRunAt!, name: next.name } : null}
          />
        </div>
      </div>
    </>
  );
}
