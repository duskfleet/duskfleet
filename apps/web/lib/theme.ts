// Theme choice (DS-15): shared by the server layout (init script) and the client ThemeSwitch.

export type Theme = "device" | "light" | "dark";

/** localStorage key; absent = Device. */
export const THEME_KEY = "duskfleet-theme";

/** Inline in <head> (app/layout.tsx): applies the stored choice before the first paint, no flash. */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
