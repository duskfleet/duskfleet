#!/usr/bin/env node
/**
 * Assembles the publishable `duskfleet` package (packages/duskfleet) from the built workspaces.
 *
 * `@duskfleet/core` is never published on its own: it is bundled into the tarball. This step
 * copies packages/mcp/dist to packages/duskfleet/dist and packages/core/dist to
 * packages/duskfleet/dist/core, then rewrites every `@duskfleet/core` import of the copied mcp
 * files into a relative path. Only runtime files are copied (`.js` and `tools.json`): no
 * declarations, no source maps. No bundler, no new dependency.
 *
 * It also copies README.md and LICENSE next to the package.json of both published packages
 * (git-ignored copies: npm only packs files inside the package folder; the README gets absolute
 * image and link URLs for npmjs.com, see npmReadme) and fails when the
 * runtime dependencies of `duskfleet` drift from those of core + mcp.
 *
 * Usage: node scripts/assemble-package.mjs   (after `npm run build`; run by `npm run build`)
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreDist = path.join(root, "packages", "core", "dist");
const mcpDist = path.join(root, "packages", "mcp", "dist");
const pkgDir = path.join(root, "packages", "duskfleet");
const out = path.join(pkgDir, "dist");
const CORE = "@duskfleet/core";

for (const dir of [coreDist, mcpDist]) {
  if (!existsSync(path.join(dir, "index.js"))) fail(`${path.relative(root, dir)} is missing: run npm run build first`);
}

rmSync(out, { recursive: true, force: true });
copyTree(mcpDist, out, (file) => file.endsWith(".js") || path.basename(file) === "tools.json");
copyTree(coreDist, path.join(out, "core"), (file) => file.endsWith(".js"));

// Rewrite the core imports of the mcp files (core's own files only import each other relatively).
const coreEntry = path.join(out, "core", "index.js");
let rewritten = 0;
for (const file of walk(out)) {
  if (!file.endsWith(".js")) continue;
  let text = readFileSync(file, "utf8").replace(/^\/\/# sourceMappingURL=.*$/m, "");
  if (!file.startsWith(path.join(out, "core") + path.sep)) {
    let rel = path.relative(path.dirname(file), coreEntry).split(path.sep).join("/");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    text = text.replace(/(["'])@duskfleet\/core\1/g, (_m, q) => {
      rewritten++;
      return `${q}${rel}${q}`;
    });
  }
  // A quoted specifier is an import (comments may still name the package).
  if (/(["'])@duskfleet\/core(\/[^"']*)?\1/.test(text)) {
    fail(`${path.relative(root, file)} still imports ${CORE} after the rewrite`);
  }
  writeFileSync(file, text);
}
for (const bin of ["cli.js", "index.js"]) chmodSync(path.join(out, bin), 0o755);

// Runtime dependencies of the bundle = those of core + mcp, minus core itself.
const pkg = readJson(path.join(pkgDir, "package.json"));
const expected = {};
for (const dir of ["packages/core", "packages/mcp"]) {
  for (const [name, range] of Object.entries(readJson(path.join(root, dir, "package.json")).dependencies ?? {})) {
    if (name !== CORE) expected[name] = range;
  }
}
const actual = pkg.dependencies ?? {};
const drift = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter(
  (name) => expected[name] !== actual[name],
);
if (drift.length) {
  fail(
    `packages/duskfleet/package.json dependencies differ from core + mcp for ${drift.join(", ")}: ` +
      `expected ${JSON.stringify(expected)}`,
  );
}

for (const target of [pkgDir, path.join(root, "apps", "web")]) {
  copyFileSync(path.join(root, "LICENSE"), path.join(target, "LICENSE"));
}
writeFileSync(path.join(pkgDir, "README.md"), npmReadme(readFileSync(path.join(root, "README.md"), "utf8")));

console.log(`assemble-package: ${path.relative(root, out)} ready (${rewritten} ${CORE} imports rewritten)`);

/**
 * The README as npmjs.com renders it: relative image paths (`src`, `srcset`) become
 * raw.githubusercontent.com URLs so the banner renders, relative links become GitHub URLs, and
 * the duskfleet.com links carry the npm UTM parameters instead of the GitHub ones.
 */
function npmReadme(text) {
  const RAW = "https://raw.githubusercontent.com/duskfleet/duskfleet/main/";
  const BLOB = "https://github.com/duskfleet/duskfleet/blob/main/";
  const SITE = "https://duskfleet.com/?utm_source=npm&utm_medium=referral&utm_campaign=always-on&utm_content=readme";
  const relative = (url) => !/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(url);
  let images = 0;
  let site = 0;
  const out = text
    .replace(/\b(src|srcset)="([^"]+)"/g, (m, attr, url) => {
      if (!relative(url)) return m;
      images++;
      return `${attr}="${RAW}${url}"`;
    })
    .replace(/\]\(([^)\s]+)\)/g, (m, url) => (relative(url) ? `](${BLOB}${url})` : m))
    .replace(/https:\/\/duskfleet\.com\/?(\?[^)\s"]*)?(?=[)\s"])/g, () => {
      site++;
      return SITE;
    });
  if (images === 0) fail("README.md: no relative image to rewrite for npm (did the banner move?)");
  if (site === 0) fail("README.md: no duskfleet.com link to tag for npm");
  return out;
}

function copyTree(from, to, keep) {
  for (const file of walk(from)) {
    if (!keep(file)) continue;
    const dest = path.join(to, path.relative(from, file));
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(file, dest);
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function fail(message) {
  console.error(`assemble-package: ${message}`);
  process.exit(1);
}
