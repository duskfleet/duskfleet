// Theme choice (DS-15): shared by the server layout (init script), the footer ThemeSwitch and the
// Appearance section of /settings.

export type Theme = "device" | "light" | "dark";

/** localStorage key; absent = Device. */
export const THEME_KEY = "duskfleet-theme";

/** Window event fired by applyTheme, so every theme control on the page shows the same value. */
export const THEME_EVENT = "duskfleet-theme";

/** Inline in <head> (app/layout.tsx): applies the stored choice before the first paint, no flash. */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

/** The stored choice (client only). */
export function storedTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // no storage: Device
  }
  return "device";
}

/** Light / Dark set data-theme on <html>; Device removes it, so prefers-color-scheme decides (globals.css). Client only. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "device") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    if (theme === "device") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage can be unavailable (private mode): the choice holds for this page only.
  }
  window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: theme }));
}
