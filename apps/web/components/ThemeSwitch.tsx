"use client";

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { THEME_KEY, type Theme } from "@/lib/theme";

const OPTIONS: Array<{ value: Theme; label: string; name: string }> = [
  { value: "device", label: "Device", name: "Device (follow OS)" },
  { value: "light", label: "Light", name: "Light" },
  { value: "dark", label: "Dark", name: "Dark" },
];

/** Light / Dark set data-theme on <html>; Device removes it, so prefers-color-scheme decides (globals.css). */
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "device") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    if (theme === "device") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage can be unavailable (private mode): the choice holds for this page only.
  }
}

/** 16 px line icons, stroke 1.5: monitor = Device, sun = Light, moon = Dark. */
function ThemeIcon({ theme }: { theme: Theme }) {
  return (
    <svg
      className="theme-icon"
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {theme === "light" ? (
        <>
          <circle cx="8" cy="8" r="2.75" />
          <path d="M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
        </>
      ) : theme === "dark" ? (
        <path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1Z" />
      ) : (
        <>
          <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.25" />
          <path d="M5.5 14h5M8 11v3" />
        </>
      )}
    </svg>
  );
}

/** DS-15 theme control: icon + chevron trigger, a menu that opens upward (Device / Light / Dark). */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>("device");
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);

  // The init script already applied the stored value; this only syncs the control with it.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === "light" || stored === "dark") setTheme(stored);
    } catch {
      // no storage: stays on Device
    }
  }, []);

  useEffect(() => {
    if (open) items.current[focus]?.focus();
  }, [open, focus]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const current = OPTIONS.find((o) => o.value === theme) ?? OPTIONS[0];
  const currentIndex = OPTIONS.indexOf(current);

  const openMenu = () => {
    setFocus(currentIndex);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const pick = (value: Theme) => {
    setTheme(value);
    applyTheme(value);
    close();
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      openMenu();
    }
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = OPTIONS.length;
    if (e.key === "ArrowDown") setFocus((i) => (i + 1) % n);
    else if (e.key === "ArrowUp") setFocus((i) => (i - 1 + n) % n);
    else if (e.key === "Home") setFocus(0);
    else if (e.key === "End") setFocus(n - 1);
    else if (e.key === "Escape") close();
    else if (e.key === "Tab") setOpen(false);
    else return;
    if (e.key !== "Tab") e.preventDefault();
  };

  return (
    <div className="theme-switch" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`theme-trigger ${open ? "open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="theme-menu"
        aria-label={`Theme: ${current.label}`}
        title={`Theme: ${current.label}`}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKey}
      >
        <ThemeIcon theme={theme} />
        <span className="theme-value">{current.label}</span>
        <svg
          className="theme-chevron"
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
          <path d="M3 7.5 6 4.5l3 3" />
        </svg>
      </button>
      {open && (
        <div id="theme-menu" className="theme-menu" role="menu" aria-label="Theme" tabIndex={-1} onKeyDown={onMenuKey}>
          <div className="theme-menu-label" aria-hidden="true">
            Theme
          </div>
          {OPTIONS.map((o, i) => {
            const checked = o.value === theme;
            return (
              <button
                key={o.value}
                ref={(el) => {
                  items.current[i] = el;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                tabIndex={i === focus ? 0 : -1}
                className={`theme-item ${checked ? "checked" : ""}`}
                onClick={() => pick(o.value)}
                onMouseEnter={() => setFocus(i)}
              >
                <ThemeIcon theme={o.value} />
                <span className="theme-item-label">{o.name}</span>
                {checked && (
                  <svg
                    className="theme-check"
                    width={16}
                    height={16}
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m3.5 8.5 3 3 6-7" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
