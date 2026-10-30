"use client";

import { useRouter } from "next/navigation";
import { Fragment, type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

export type MultiSelectOption = {
  value: string;
  label: string;
  title?: string;
  /** Group heading (the agent's project); options without one are listed without heading. */
  group?: string;
  /** Server-built link that toggles this value, so the list works without JS. */
  href: string;
};

/**
 * One Runs filter as a multi-select (DS-19): a <details> whose options are plain links, so
 * without JS every click reloads the page with the list closed. With JS it adds a type-ahead,
 * Select all on the visible options, ↑ ↓ / Space / Enter / Esc, and applies each toggle at once
 * through router.replace while the list stays open. The × that drops the filter is its own link
 * next to the <summary>, never inside it.
 */
export function MultiSelect({
  param,
  label,
  noun,
  options,
  selected,
  clearHref,
  selectAllHref,
}: {
  param: string;
  label: string;
  noun: string;
  options: MultiSelectOption[];
  selected: string[];
  clearHref: string;
  selectAllHref: string;
}) {
  const router = useRouter();
  const id = useId();
  const listId = `${id}-list`;
  const rootRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const valuesRef = useRef<HTMLSpanElement>(null);
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(selected);
  // The pinned SELECTED group is fixed when the list opens, so rows do not jump while toggling.
  const [pinned, setPinned] = useState(selected);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [shown, setShown] = useState(Math.min(selected.length, 1));

  useEffect(() => setMounted(true), []);
  // The server's answer wins once it arrives (another tab, the × link, clear filters).
  const selectedKey = selected.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedKey stands for selected
  useEffect(() => setSel(selected), [selectedKey]);

  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  const names = sel.map(labelOf);

  // How many names fit before the +N badge: measured on the client, the server shows one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the names change
  useLayoutEffect(() => {
    const span = valuesRef.current;
    if (!span || names.length === 0) {
      setShown(0);
      return;
    }
    const measure = () => {
      const ctx = document.createElement("canvas").getContext("2d");
      if (!ctx) return;
      const style = getComputedStyle(span);
      ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const badge = span.nextElementSibling?.classList.contains("ms-more")
        ? (span.nextElementSibling as HTMLElement).offsetWidth + 6
        : 0;
      const room = span.clientWidth + badge;
      const width = (k: number) => ctx.measureText(names.slice(0, k).join(", ")).width;
      if (width(names.length) <= room) return setShown(names.length);
      let k = names.length - 1;
      // Room for a "+NN" badge (padding 7 + 7, gap 6).
      while (k > 1 && width(k) > room - 40) k--;
      setShown(Math.max(k, 1));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(span.parentElement ?? span);
    return () => ro.disconnect();
  }, [names.join("\n")]);

  // Click outside closes; so does Tab out of the list (focus moved to something outside). A click
  // on the list's padding has no relatedTarget and must not close it.
  useEffect(() => {
    const root = rootRef.current;
    if (!open || !root) return;
    const onDown = (e: MouseEvent) => {
      if (!root.contains(e.target as Node)) setOpen(false);
    };
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget && !root.contains(e.relatedTarget as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    root.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("mousedown", onDown);
      root.removeEventListener("focusout", onFocusOut);
    };
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const show = (next: boolean) => {
    if (next) {
      setPinned(sel);
      setQuery("");
    }
    setActive(-1);
    setOpen(next);
  };

  const apply = (next: string[]) => {
    setSel(next);
    const p = new URLSearchParams(window.location.search);
    p.delete(param);
    p.delete("limit");
    for (const v of next) p.append(param, v);
    const s = p.toString();
    router.replace(s ? `/?${s}` : "/", { scroll: false });
  };
  const toggle = (v: string) => apply(sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v]);

  const q = query.trim().toLowerCase();
  const visible = options.filter((o) => !q || o.value.toLowerCase().includes(q) || o.label.toLowerCase().includes(q));
  const pinnedRows = visible.filter((o) => pinned.includes(o.value));
  const restRows = visible.filter((o) => !pinned.includes(o.value));
  const groups: Array<{ name: string | undefined; rows: MultiSelectOption[] }> = [];
  for (const o of restRows) {
    const g = groups.find((x) => x.name === o.group);
    if (g) g.rows.push(o);
    else groups.push({ name: o.group, rows: [o] });
  }
  const flat = [...pinnedRows, ...groups.flatMap((g) => g.rows)];
  const optionId = (v: string) => `${id}-o-${v}`;
  const activeOpt = active >= 0 ? flat[active] : undefined;

  useEffect(() => {
    if (activeOpt) document.getElementById(optionId(activeOpt.value))?.scrollIntoView({ block: "nearest" });
  });

  const onListKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a < 0 ? (step > 0 ? 0 : flat.length - 1) : (a + step + flat.length) % flat.length));
    } else if ((e.key === " " || e.key === "Enter") && activeOpt) {
      e.preventDefault();
      toggle(activeOpt.value);
    } else if (e.key === "Enter") {
      e.preventDefault();
    } else if (e.key === "Escape") {
      e.preventDefault();
      show(false);
      summaryRef.current?.focus();
    }
  };

  const row = (o: MultiSelectOption) => {
    const checked = sel.includes(o.value);
    const isActive = activeOpt?.value === o.value;
    return (
      <a
        key={o.value}
        id={optionId(o.value)}
        role="option"
        aria-selected={checked}
        href={o.href}
        tabIndex={-1}
        title={o.title}
        className={`ms-option ${checked ? "checked" : ""} ${isActive ? "active" : ""}`}
        onClick={(e) => {
          e.preventDefault();
          toggle(o.value);
        }}
        onMouseMove={() => setActive(flat.indexOf(o))}
      >
        <span className="ms-box" aria-hidden="true">
          {checked && (
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M4 8.2l2.6 2.6L12 5.4" />
            </svg>
          )}
        </span>
        {o.label}
      </a>
    );
  };

  const more = names.length - shown;
  const visibleValues = visible.map((o) => o.value);

  return (
    <div className={`ms ${sel.length ? "has-value" : ""}`} ref={rootRef}>
      <details open={open}>
        <summary
          ref={summaryRef}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          onClick={(e) => {
            e.preventDefault();
            show(!open);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && !open) {
              e.preventDefault();
              show(true);
            } else if (e.key === "Escape" && open) {
              e.preventDefault();
              show(false);
            }
          }}
        >
          <span className="ms-label">{label}</span>
          {sel.length === 0 ? (
            <span className="ms-values">all</span>
          ) : (
            <>
              <span className="ms-values" ref={valuesRef}>
                {names.slice(0, shown).join(", ")}
              </span>
              {more > 0 && <span className="ms-more">+{more}</span>}
              <span className="ms-count" title={names.join(", ")}>
                {sel.length}
              </span>
              <span className="ms-clear-slot" aria-hidden="true" />
            </>
          )}
          <svg className="ms-chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </summary>
        <div className="ms-pop">
          {mounted && (
            <input
              ref={inputRef}
              type="text"
              className="ms-filter"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeOpt ? optionId(activeOpt.value) : undefined}
              aria-label={`Filter ${noun}`}
              placeholder={`Filter ${noun}…`}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(-1);
              }}
              onKeyDown={onListKey}
            />
          )}
          <div className="ms-count-line">
            <span>
              {sel.length} of {options.length} selected
            </span>
            <span className="ms-actions">
              <a
                href={selectAllHref}
                onClick={(e) => {
                  e.preventDefault();
                  apply([...sel, ...visibleValues.filter((v) => !sel.includes(v))]);
                }}
              >
                Select all
              </a>
              <a
                href={clearHref}
                onClick={(e) => {
                  e.preventDefault();
                  apply([]);
                }}
              >
                Clear
              </a>
            </span>
          </div>
          <div className="ms-list" role="listbox" id={listId} aria-multiselectable="true" aria-label={label}>
            {pinnedRows.length > 0 && (
              // biome-ignore lint/a11y/useSemanticElements: a listbox group, not a form fieldset
              <div role="group" aria-labelledby={`${id}-g-sel`}>
                <div className="ms-group" id={`${id}-g-sel`}>
                  Selected · {pinnedRows.length}
                </div>
                {pinnedRows.map(row)}
              </div>
            )}
            {groups.map((g, i) =>
              g.name ? (
                // biome-ignore lint/a11y/useSemanticElements: a listbox group, not a form fieldset
                <div role="group" aria-labelledby={`${id}-g-${i}`} key={g.name}>
                  <div className="ms-group" id={`${id}-g-${i}`}>
                    {g.name} · {g.rows.length}
                  </div>
                  {g.rows.map(row)}
                </div>
              ) : (
                <Fragment key="">{g.rows.map(row)}</Fragment>
              ),
            )}
            {flat.length === 0 && <div className="ms-empty">No {noun} match.</div>}
          </div>
          {mounted && <div className="ms-hint">↑ ↓ move · Space toggles · Enter keeps open · Esc closes</div>}
        </div>
      </details>
      {sel.length > 0 && (
        <a
          href={clearHref}
          className="ms-clear"
          aria-label={`Clear ${label.toLowerCase()} filter`}
          onClick={(e) => {
            e.preventDefault();
            show(false);
            apply([]);
          }}
        >
          ×
        </a>
      )}
    </div>
  );
}
