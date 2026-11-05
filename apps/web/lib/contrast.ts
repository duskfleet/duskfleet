// WCAG 2.x contrast of the design tokens in app/globals.css (#35): parses the custom properties,
// resolves light-dark() for one mode and var() references, composites translucent fills over an
// opaque surface and computes the contrast ratio. Pure: the caller reads the CSS file.

export type Mode = "light" | "dark";

/** An sRGB colour, channels 0-255, alpha 0-1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** `--name: value;` declarations of the stylesheet, comments stripped; a later declaration wins. */
export function parseTokens(css: string): Map<string, string> {
  const tokens = new Map<string, string>();
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of clean.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
    tokens.set(match[1], match[2].trim());
  }
  return tokens;
}

/** Splits the arguments of a CSS function at its top-level commas. */
function splitArgs(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      args.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(inner.slice(start).trim());
  return args;
}

/** The value of a token in one mode: light-dark() picks its side, var() is followed. */
export function resolveToken(tokens: Map<string, string>, name: string, mode: Mode, seen: string[] = []): string {
  if (seen.includes(name)) throw new Error(`circular token ${[...seen, name].join(" -> ")}`);
  const raw = tokens.get(name);
  if (raw === undefined) throw new Error(`unknown token ${name}`);
  return resolveValue(tokens, raw, mode, [...seen, name]);
}

function resolveValue(tokens: Map<string, string>, value: string, mode: Mode, seen: string[]): string {
  const v = value.trim();
  const ld = /^light-dark\(([\s\S]*)\)$/.exec(v);
  if (ld) {
    const [light, dark] = splitArgs(ld[1]);
    if (light === undefined || dark === undefined) throw new Error(`light-dark() needs two values: ${v}`);
    return resolveValue(tokens, mode === "light" ? light : dark, mode, seen);
  }
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) return resolveToken(tokens, ref[1], mode, seen);
  return v;
}

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(...)` or `rgba(...)` with comma-separated channels. */
export function parseColor(value: string): Rgba {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    return {
      r: Number.parseInt(h.slice(0, 2), 16),
      g: Number.parseInt(h.slice(2, 4), 16),
      b: Number.parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(v);
  if (fn) {
    const parts = fn[1].split(",").map((p) => Number(p.trim()));
    if ((parts.length === 3 || parts.length === 4) && parts.every((n) => Number.isFinite(n))) {
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
    }
  }
  throw new Error(`not a colour: ${value}`);
}

/** `top` painted over an opaque `base` (source-over). */
export function composite(top: Rgba, base: Rgba): Rgba {
  if (base.a !== 1) throw new Error("the base of a composite must be opaque");
  const mix = (t: number, b: number) => t * top.a + b * (1 - top.a);
  return { r: mix(top.r, base.r), g: mix(top.g, base.g), b: mix(top.b, base.b), a: 1 };
}

/** WCAG 2.x relative luminance of an opaque colour. */
export function luminance(c: Rgba): number {
  const lin = (channel: number) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 2.x contrast ratio, 1 to 21. Both colours must be opaque (composite translucent ones first). */
export function contrastRatio(a: Rgba, b: Rgba): number {
  if (a.a !== 1 || b.a !== 1) throw new Error("contrast needs opaque colours");
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Contrast of token `fg` over token `bg` in one mode. A translucent `bg` is composited over the
 * opaque `surface` token first (badge fills over --panel); a translucent `fg` over the result.
 */
export function tokenContrast(
  tokens: Map<string, string>,
  mode: Mode,
  fg: string,
  bg: string,
  surface = "--panel",
): number {
  const color = (name: string) => parseColor(resolveToken(tokens, name, mode));
  let ground = color(bg);
  if (ground.a !== 1) ground = composite(ground, color(surface));
  let ink = color(fg);
  if (ink.a !== 1) ink = composite(ink, ground);
  return contrastRatio(ink, ground);
}
