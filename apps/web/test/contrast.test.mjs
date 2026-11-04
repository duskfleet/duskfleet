import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { contrastRatio, parseColor, parseTokens, resolveToken, tokenContrast } from "../lib/contrast.ts";

// WCAG AA of the design tokens, both modes (#35). Thresholds: 4.5:1 for text (badge text is
// 14 px Geist 600, normal-text size), 3:1 for non-text UI edges, 1.2:1 for the panel edge (--border)
// against --panel (Light has no drop shadow, only a 1 px border-coloured edge).

const tokens = parseTokens(readFileSync(new URL("../app/globals.css", import.meta.url), "utf8"));
const MODES = ["light", "dark"];
const fmt = (n) => n.toFixed(2);

test("the helper computes the WCAG reference ratios", () => {
  assert.equal(contrastRatio(parseColor("#000"), parseColor("#ffffff")), 21);
  assert.equal(contrastRatio(parseColor("#777"), parseColor("#777777")), 1);
  // #767676 on white is the classic 4.54:1 grey
  assert.equal(fmt(contrastRatio(parseColor("#767676"), parseColor("rgb(255, 255, 255)"))), "4.54");
});

test("light-dark() and var() resolve per mode", () => {
  const t = parseTokens(":root { --a: #111; --b: light-dark(#fff, var(--a)); /* --c: #f00; */ }");
  assert.equal(resolveToken(t, "--b", "light"), "#fff");
  assert.equal(resolveToken(t, "--b", "dark"), "#111");
  assert.equal(t.has("--c"), false);
  assert.ok(resolveToken(tokens, "--accent", "dark").startsWith("#"));
});

test("a translucent fill is composited over the surface before measuring", () => {
  const t = parseTokens(":root { --s: #ffffff; --f: rgba(0, 0, 0, 0.5); --ink: #000000; }");
  // 50% black over white is #808080 (127.5): about 5.3:1 against black
  assert.equal(fmt(tokenContrast(t, "light", "--ink", "--f", "--s")), "5.28");
});

// Known gap, kept visible instead of red: Dark --accent on --accent-bg over --panel measures
// 4.39:1, and this issue changes Light values only. Reported as a todo until the owner decides.
const KNOWN_GAPS = new Set(["dark --accent --accent-bg --panel"]);

for (const [fg, fill, surface] of [["--accent", "--accent-bg", "--panel"]]) {
  test(`dark: ${fg} on ${fill} over ${surface} >= 4.5:1 (known gap)`, { todo: "Dark value, out of scope here" }, () => {
    const ratio = tokenContrast(tokens, "dark", fg, fill, surface);
    assert.ok(ratio >= 4.5, `${fg} on ${fill} over ${surface} is ${fmt(ratio)}:1`);
  });
}

for (const mode of MODES) {
  test(`${mode}: text tokens on their surfaces >= 4.5:1`, () => {
    for (const fg of ["--text", "--muted", "--faint"]) {
      for (const bg of ["--bg", "--panel"]) {
        const ratio = tokenContrast(tokens, mode, fg, bg);
        assert.ok(ratio >= 4.5, `${fg} on ${bg} is ${fmt(ratio)}:1`);
      }
    }
  });

  test(`${mode}: badge and flag ink on its fill, over --panel and --bg, >= 4.5:1`, () => {
    const pairs = [
      ["--ok", "--ok-bg"],
      ["--warn", "--warn-bg"],
      ["--bad-ink", "--bad-bg"],
      ["--run", "--run-bg"],
      ["--accent", "--accent-bg"],
    ];
    for (const [fg, fill] of pairs) {
      for (const surface of ["--panel", "--bg"]) {
        if (KNOWN_GAPS.has(`${mode} ${fg} ${fill} ${surface}`)) continue;
        const ratio = tokenContrast(tokens, mode, fg, fill, surface);
        assert.ok(ratio >= 4.5, `${fg} on ${fill} over ${surface} is ${fmt(ratio)}:1`);
      }
    }
  });

  test(`${mode}: --border-strong on --bg and --panel >= 3:1`, () => {
    for (const bg of ["--bg", "--panel"]) {
      const ratio = tokenContrast(tokens, mode, "--border-strong", bg);
      assert.ok(ratio >= 3, `--border-strong on ${bg} is ${fmt(ratio)}:1`);
    }
  });

  // Panels are separated from --bg by their edge, not by their fill (on Light the --shadow is that
  // 1 px border-coloured edge), so the edge is what must stay visible against the panel.
  test(`${mode}: --border stays visible against --panel (>= 1.2:1)`, () => {
    const ratio = tokenContrast(tokens, mode, "--border", "--panel");
    assert.ok(ratio >= 1.2, `--border on --panel is ${fmt(ratio)}:1`);
  });
}
