"use client";

import type { EditableGlobalKey, GlobalValue } from "@duskfleet/core";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useId, useRef, useState, useTransition } from "react";
import { saveSettingsAction, setSchedulerEnabledAction } from "@/app/settings/actions";
import { useTheme } from "@/components/ThemeSwitch";
import {
  type Draft,
  type FieldDef,
  fieldError,
  formatValue,
  fromDraft,
  SECTIONS,
  SETTING_SOURCES,
  toDraft,
} from "@/lib/settings";
import { applyTheme, type Theme } from "@/lib/theme";

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---- section frame: collapsible card with a header and an optional footer --------------------

function Section({
  id,
  title,
  blurb,
  status,
  summary,
  danger,
  children,
  footer,
}: {
  id: string;
  title: string;
  blurb: string;
  status?: ReactNode;
  summary: string;
  danger?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const bodyId = `${id}-body`;
  return (
    <section id={id} className={`card settings-section ${danger ? "danger" : ""}`} aria-labelledby={`${id}-title`}>
      <div className="section-head">
        <button
          type="button"
          className="section-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
        >
          <svg
            className="chev"
            width={12}
            height={12}
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 4.5 6 7.5l3-3" />
          </svg>
          <span id={`${id}-title`} className="section-title">
            {danger && <span aria-hidden="true">⚠ </span>}
            {title}
          </span>
        </button>
        <span className="section-blurb">{open ? blurb : summary}</span>
        {status && <span className="section-status">{status}</span>}
      </div>
      <div id={bodyId} hidden={!open}>
        {children}
        {footer}
      </div>
    </section>
  );
}

function Marker({ restart, label }: { restart?: boolean; label?: string }) {
  return restart ? (
    <span className="marker restart">↻ {label ?? "Restart MCP host"}</span>
  ) : (
    <span className="marker next">→ {label ?? "Next run"}</span>
  );
}

// ---- modal dialog: native <dialog> (focus stays inside, Escape cancels), focus back to the opener --

function Dialog({
  open,
  danger,
  title,
  onCancel,
  children,
}: {
  open: boolean;
  danger?: boolean;
  title: string;
  onCancel: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement as HTMLElement | null;
      d.showModal();
    } else if (!open && d.open) {
      d.close();
      opener.current?.focus();
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`settings-dialog ${danger ? "danger" : ""}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <h3 id={titleId}>{title}</h3>
      {children}
    </dialog>
  );
}

// ---- Appearance -------------------------------------------------------------------------------

const THEMES: Array<{ value: Theme; label: string }> = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "device", label: "Device" },
];

function ThemeTile({ mode, selected, onPick }: { mode: "dark" | "light"; selected: boolean; onPick: () => void }) {
  return (
    <div className="theme-tile-wrap">
      <button
        type="button"
        className={`theme-tile ${mode} ${selected ? "selected" : ""}`}
        onClick={onPick}
        aria-label={`${mode === "dark" ? "Dark" : "Light"} preview`}
        aria-pressed={selected}
        tabIndex={-1}
      >
        <span className="tile-nav">
          <span className="tile-brand">
            dusk<span className="fleet">fleet</span>
          </span>
          <span>Runs</span>
          <span>Agents</span>
          <span>Schedules</span>
        </span>
        <span className="tile-card">
          <span>
            Max concurrent runs
            <span className="tile-sub">Applies on the next run</span>
          </span>
          <span className="tile-num">2</span>
        </span>
      </button>
      <span className="tile-caption">
        {mode === "dark" ? "Dark" : "Light"}
        {selected && <span className="muted"> · selected</span>}
      </span>
    </div>
  );
}

export function AppearanceSection() {
  const theme = useTheme();
  const current = THEMES.find((t) => t.value === theme)!;
  return (
    <Section
      id="appearance"
      title="Appearance"
      blurb="Dashboard only, kept in this browser; not a key of duskfleet.yaml"
      summary={`Theme ${current.label}`}
    >
      <div className="field">
        <div className="field-text">
          <div className="field-label" id="theme-label">
            Theme <code>theme</code>
          </div>
          <p className="field-desc">
            Dark and Light are the two modes of the same tokens. Device follows the operating system setting.
          </p>
        </div>
        <div className="field-control">
          <div className="segmented" role="radiogroup" aria-labelledby="theme-label">
            {THEMES.map((t) => (
              // biome-ignore lint/a11y/useSemanticElements: a segmented control styled as buttons; radiogroup semantics, applies on click
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={theme === t.value}
                className={theme === t.value ? "on" : ""}
                onClick={() => applyTheme(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <Marker label="Applies now · this browser" />
        </div>
        <div className="theme-tiles">
          <ThemeTile mode="dark" selected={theme === "dark"} onPick={() => applyTheme("dark")} />
          <ThemeTile mode="light" selected={theme === "light"} onPick={() => applyTheme("light")} />
        </div>
      </div>
    </Section>
  );
}

// ---- a config/duskfleet.yaml section -------------------------------------------------------------

type Values = Partial<Record<EditableGlobalKey, GlobalValue>>;

function Control({
  def,
  id,
  draft,
  invalid,
  agents,
  onChange,
}: {
  def: FieldDef;
  id: string;
  draft: Draft;
  invalid: boolean;
  agents: string[];
  onChange: (d: Draft) => void;
}) {
  switch (def.kind) {
    case "int":
    case "number":
      return (
        <span className="num-input">
          <input
            id={id}
            type="text"
            inputMode={def.kind === "int" ? "numeric" : "decimal"}
            value={draft as string}
            aria-invalid={invalid}
            aria-describedby={`${id}-state`}
            onChange={(e) => onChange(e.target.value)}
          />
          {def.unit && <span className="unit">{def.unit}</span>}
        </span>
      );
    case "bool":
      return (
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={draft === true}
          className="toggle"
          onClick={() => onChange(draft !== true)}
        >
          <span className="track" aria-hidden="true">
            <span className="knob" />
          </span>
          {draft === true ? "On" : "Off"}
        </button>
      );
    case "sources": {
      const list = draft as string[];
      return (
        // biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form fieldset
        <span className="chips" role="group" id={id} aria-label="Setting sources">
          {SETTING_SOURCES.map((s) => {
            const on = list.includes(s);
            return (
              <button
                key={s}
                type="button"
                className={`chip ${on ? "on" : ""}`}
                aria-pressed={on}
                onClick={() => onChange(on ? list.filter((x) => x !== s) : [...list, s])}
              >
                {on ? "✓ " : ""}
                {s}
              </button>
            );
          })}
        </span>
      );
    }
    case "roots": {
      const list = draft as string[];
      return (
        <span className="roots" id={id}>
          {list.length === 0 && <span className="roots-empty">No roots: any directory</span>}
          {list.map((r, i) => (
            <span key={i} className="root-row">
              <input
                type="text"
                className="mono"
                value={r}
                aria-label={`Project root ${i + 1}`}
                placeholder="~/Projects"
                onChange={(e) => onChange(list.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <button
                type="button"
                className="btn small"
                aria-label={`Remove root ${i + 1}`}
                onClick={() => onChange(list.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
          <button type="button" className="btn small" onClick={() => onChange([...list, ""])}>
            + Add root
          </button>
        </span>
      );
    }
    case "agent":
      return (
        <select id={id} value={draft as string} onChange={(e) => onChange(e.target.value)}>
          <option value="">None, agent_id required</option>
          {agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      );
    default:
      return (
        <input
          id={id}
          type="text"
          className="mono text-input"
          value={draft as string}
          placeholder="claude on PATH"
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

export function ConfigSection({
  id,
  values,
  agents,
  schedulerEnabled,
}: {
  id: string;
  values: Values;
  agents: string[];
  schedulerEnabled: boolean;
}) {
  const def = SECTIONS.find((s) => s.id === id)!;
  const router = useRouter();
  const [base, setBase] = useState<Values>(values);
  const initialDrafts = (v: Values) => Object.fromEntries(def.fields.map((f) => [f.key, toDraft(f, v[f.key] ?? null)]));
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => initialDrafts(values));
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const rows = def.fields.map((f) => {
    const draft = drafts[f.key]!;
    const err = fieldError(f, draft);
    const was = base[f.key] ?? null;
    const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(f, was));
    return { f, draft, err, was, dirty, next: err ? null : fromDraft(f, draft) };
  });
  const changed = rows.filter((r) => r.dirty);
  const invalid = rows.filter((r) => r.err);
  const restartKeys = changed.filter((r) => r.f.restart).map((r) => r.f.key);

  const setDraft = (key: string, d: Draft) => setDrafts((all) => ({ ...all, [key]: d }));
  const discard = () => setDrafts(initialDrafts(base));
  const save = () =>
    start(async () => {
      setError(null);
      const res = await saveSettingsAction(changed.map((r) => ({ key: r.f.key, value: r.next! })));
      if (!res.ok) {
        setError(res.message);
        return;
      }
      const nextBase = { ...base };
      const stamp: Record<string, string> = {};
      for (const r of changed) {
        nextBase[r.f.key] = r.next!;
        stamp[r.f.key] = res.savedAt!;
      }
      setBase(nextBase);
      setDrafts(initialDrafts(nextBase));
      setSaved((s) => ({ ...s, ...stamp }));
      setConfirming(false);
      router.refresh();
    });

  const restartCount = def.fields.filter((f) => f.restart).length;
  const status =
    changed.length > 0 ? (
      <span className="warn-text">{changed.length} unsaved</span>
    ) : id === "scheduler" ? (
      <span className={schedulerEnabled ? "ok-text" : "faint"}>● {schedulerEnabled ? "enabled" : "off"}</span>
    ) : restartCount > 0 ? (
      <span className="warn-text">
        ↻ {restartCount} {restartCount === 1 ? "needs" : "need"} a restart
      </span>
    ) : undefined;

  return (
    <Section
      id={id}
      title={def.title}
      blurb={def.blurb}
      status={status}
      summary={def.fields.map((f) => `${f.label.toLowerCase()} ${formatValue(f, base[f.key] ?? null)}`).join(" · ")}
      footer={
        <div className="section-foot">
          <span className={invalid.length ? "bad-text" : changed.length ? "warn-text" : "faint"} aria-live="polite">
            {invalid.length > 0
              ? `Fix ${plural(invalid.length, "field")} to save this section`
              : changed.length > 0
                ? `${plural(changed.length, "unsaved change")}: ${changed
                    .map((r) => `${r.f.key} ${formatValue(r.f, r.was)} → ${formatValue(r.f, r.next)}`)
                    .join(", ")}`
                : "No unsaved changes"}
          </span>
          <span className="foot-actions">
            <button type="button" className="btn" disabled={changed.length === 0 || pending} onClick={discard}>
              Discard
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={changed.length === 0 || invalid.length > 0 || pending}
              onClick={() => {
                setError(null);
                setConfirming(true);
              }}
            >
              Save {def.title.toLowerCase()}…
            </button>
          </span>
        </div>
      }
    >
      {rows.map(({ f, draft, err, was, dirty }) => {
        const fid = `f-${f.key.replace(/\./g, "-")}`;
        const resetTarget = f.resetTo ?? f.default;
        const atDefault = JSON.stringify(draft) === JSON.stringify(toDraft(f, resetTarget));
        return (
          <div key={f.key} className={`field ${dirty ? "unsaved" : ""} ${err ? "invalid" : ""}`}>
            <div className="field-text">
              <div className="field-label">
                <label htmlFor={fid}>{f.label}</label> <code>{f.key}</code>
              </div>
              <p className="field-desc">{f.description}</p>
              <div className="field-default">
                Default {f.defaultLabel}
                {!atDefault && (
                  <>
                    {" · "}
                    <button type="button" className="link-btn" onClick={() => setDraft(f.key, toDraft(f, resetTarget))}>
                      Reset to default ({formatValue(f, resetTarget)})
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="field-control">
              <Control
                def={f}
                id={fid}
                draft={draft}
                invalid={err !== null}
                agents={agents}
                onChange={(d) => setDraft(f.key, d)}
              />
              <span className="field-state" id={`${fid}-state`}>
                {err ? (
                  <span className="bad-text">⚠ {err}</span>
                ) : dirty ? (
                  <>
                    <span className="warn-text">● Unsaved · was {formatValue(f, was)}</span>
                    <button type="button" className="link-btn" onClick={() => setDraft(f.key, toDraft(f, was))}>
                      Reset to {formatValue(f, was)}
                    </button>
                  </>
                ) : saved[f.key] ? (
                  <span className="ok-text">✓ Saved · {hhmm(saved[f.key]!)}</span>
                ) : null}
              </span>
              <Marker restart={f.restart} />
            </div>
          </div>
        );
      })}
      {id === "scheduler" && (
        <p className="section-note">
          The kill switch (<code>scheduler.enabled</code>) is in the <a href="#danger">Danger zone</a> at the bottom of
          this page.
        </p>
      )}

      <Dialog
        open={confirming}
        title={`Save ${plural(changed.length, "change")} to ${def.title}?`}
        onCancel={() => setConfirming(false)}
      >
        <ul className="dialog-changes">
          {changed.map((r) => (
            <li key={r.f.key}>
              <code>{r.f.key}</code>
              <code>
                {formatValue(r.f, r.was)} → {formatValue(r.f, r.next)}
              </code>
            </li>
          ))}
        </ul>
        <p>
          {restartKeys.length > 0
            ? `${restartKeys.join(" and ")} ${restartKeys.length === 1 ? "applies" : "apply"} once the MCP host restarts; the rest on the next run.`
            : "Applies on the next run. Runs already going keep their settings."}{" "}
          Written to <code>config/duskfleet.yaml</code>.
        </p>
        {error && <p className="bad-text">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={pending}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={pending}>
            {pending ? "Saving…" : `Save ${plural(changed.length, "change")}`}
          </button>
        </div>
      </Dialog>
    </Section>
  );
}

// ---- Danger zone: the scheduler kill switch, never part of a section save ----------------------

export function DangerZone({
  enabled,
  activeSchedules,
  next,
}: {
  enabled: boolean;
  activeSchedules: number;
  next: { at: string; name: string } | null;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string; at?: string } | null>(null);
  const [pending, start] = useTransition();

  const set = (on: boolean) =>
    start(async () => {
      const res = await setSchedulerEnabledAction(on);
      setMessage({ ok: res.ok, text: res.message, at: res.savedAt });
      if (res.ok) {
        setConfirming(false);
        router.refresh();
      }
    });

  return (
    <Section
      id="danger"
      title="Danger zone"
      blurb="Acts at once, after a confirmation; not part of any section save"
      summary={enabled ? `Scheduler on · ${plural(activeSchedules, "schedule")} active` : "Scheduler off"}
      danger
    >
      <div className="field">
        <div className="field-text">
          <div className="field-label">
            Scheduler kill switch <code>scheduler.enabled</code>
          </div>
          <p className="field-desc">
            Re-read every tick. Off stops every schedule from firing until it is turned back on; missed ticks are not
            caught up. Runs already going finish.
          </p>
          <div className="field-default">Default on</div>
        </div>
        <div className="field-control">
          <span className={enabled ? "ok-text" : "faint"}>
            ● {enabled ? `Scheduler on · ${plural(activeSchedules, "schedule")} active` : "Scheduler off"}
          </span>
          {enabled ? (
            <button type="button" className="btn danger" onClick={() => setConfirming(true)} disabled={pending}>
              Turn scheduler off…
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => set(true)} disabled={pending}>
              Turn scheduler on
            </button>
          )}
          <span className="field-state" aria-live="polite">
            {message &&
              (message.ok && message.at ? (
                <span className="ok-text">✓ Saved · {hhmm(message.at)}</span>
              ) : (
                <span className="bad-text">{message.text}</span>
              ))}
          </span>
          <Marker label="Next tick" />
        </div>
      </div>

      <Dialog open={confirming} danger title="Turn the scheduler off?" onCancel={() => setConfirming(false)}>
        <p>
          Every schedule stops firing until you turn it back on:{" "}
          {activeSchedules === 0
            ? "no schedule is active right now."
            : `${plural(activeSchedules, "active schedule")}${next ? `, next firing ${hhmm(next.at)} (${next.name})` : ""}.`}
        </p>
        <p className="muted">
          Missed ticks are not caught up. Runs already going finish. Sets <code>scheduler.enabled: false</code>.
        </p>
        {message && !message.ok && <p className="bad-text">{message.text}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={pending}>
            Keep it on
          </button>
          <button type="button" className="btn danger" onClick={() => set(false)} disabled={pending}>
            {pending ? "Turning off…" : "Turn scheduler off"}
          </button>
        </div>
      </Dialog>
    </Section>
  );
}
