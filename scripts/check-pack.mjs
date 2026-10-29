#!/usr/bin/env node
/**
 * Pack gate for the two published packages, `duskfleet` (packages/duskfleet) and
 * `@duskfleet/web` (apps/web). Runs `npm pack --dry-run --json` on both and fails when:
 *   - a tarball holds a file outside its allow-list, or test files, source maps, data/,
 *     .env*, node_modules or build caches;
 *   - a published manifest lists @duskfleet/core in any dependency field read at install
 *     time (core is bundled, never published);
 *   - a `bin` entry is one npm would drop at publish time: a path with a `./` prefix, `..`,
 *     an absolute path, or a file that is not in the tarball (npm 11 "auto-corrects" the
 *     manifest by removing the entry, and `npx duskfleet` then has no executable: release
 *     run of 2026-10-28);
 *   - the two versions differ (one bump touches both);
 *   - the `duskfleet` bundle is missing (run `npm run build`).
 * Prints both tarball sizes. The dashboard build (.next) is only required with
 * --require-web-build (CI runs it after `npm run build:web`); without it an unbuilt dashboard is
 * a warning, so `npm run check` stays fast.
 *
 * Usage: node scripts/check-pack.mjs [--require-web-build]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireWebBuild = process.argv.includes("--require-web-build");

const PACKAGES = [
  {
    name: "duskfleet",
    dir: "packages/duskfleet",
    allowed: [/^package\.json$/, /^README\.md$/, /^LICENSE$/, /^dist\/.+\.js$/, /^dist\/tools\.json$/],
    required: ["dist/cli.js", "dist/index.js", "dist/core/index.js"],
  },
  {
    name: "@duskfleet/web",
    dir: "apps/web",
    allowed: [
      /^package\.json$/,
      /^LICENSE$/,
      /^bin\/.+\.mjs$/,
      /^\.next\//,
      /^public\//,
      /^next\.config\.mjs$/,
      /^tools\.json$/,
    ],
    required: ["bin/start.mjs", "next.config.mjs"],
  },
];

const FORBIDDEN = [
  { re: /(^|\/)test\//, why: "test files" },
  { re: /\.test\.[cm]?[jt]s$/, why: "test files" },
  { re: /\.map$/, why: "source map" },
  { re: /(^|\/)data\//, why: "runtime data" },
  { re: /(^|\/)\.env/, why: "environment file" },
  { re: /(^|\/)node_modules\//, why: "node_modules" },
  { re: /^\.next\/(cache|types)\//, why: "Next.js build cache" },
  { re: /\.tsbuildinfo$/, why: "build cache" },
  { re: /\.(db|sqlite|jsonl)$/, why: "database or run log" },
];

const DEP_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
  "bundledDependencies",
];

const args = ["pack", "--dry-run", "--json", "--ignore-scripts", ...PACKAGES.flatMap((p) => ["-w", p.name])];
const reports = JSON.parse(
  execFileSync("npm", args, { cwd: root, encoding: "utf8", shell: process.platform === "win32", maxBuffer: 64 << 20 }),
);

const problems = [];
const warnings = [];
const versions = new Map();

for (const spec of PACKAGES) {
  const report = reports.find((r) => r.name === spec.name);
  if (!report) {
    problems.push(`${spec.name}: npm pack returned no report`);
    continue;
  }
  const manifest = JSON.parse(readFileSync(path.join(root, spec.dir, "package.json"), "utf8"));
  versions.set(spec.name, manifest.version);
  if (manifest.private) problems.push(`${spec.name}: package.json is private`);
  for (const field of DEP_FIELDS) {
    const deps = manifest[field];
    const listed = Array.isArray(deps) ? deps : Object.keys(deps ?? {});
    if (listed.includes("@duskfleet/core")) problems.push(`${spec.name}: @duskfleet/core is listed in ${field}`);
  }

  const files = report.files.map((f) => f.path);
  for (const file of files) {
    const bad = FORBIDDEN.find((f) => f.re.test(file));
    if (bad) problems.push(`${spec.name}: ${file} (${bad.why})`);
    else if (!spec.allowed.some((re) => re.test(file)))
      problems.push(`${spec.name}: ${file} is outside the allow-list`);
  }
  for (const file of spec.required) {
    if (!files.includes(file)) problems.push(`${spec.name}: ${file} is missing (run npm run build)`);
  }
  const bins = typeof manifest.bin === "string" ? { [manifest.name]: manifest.bin } : (manifest.bin ?? {});
  if (!Object.keys(bins).length) problems.push(`${spec.name}: package.json has no bin`);
  for (const [name, target] of Object.entries(bins)) {
    if (
      typeof target !== "string" ||
      target.startsWith("./") ||
      target.startsWith("/") ||
      /(^|\/)\.\.(\/|$)/.test(target)
    )
      problems.push(
        `${spec.name}: bin ${name} -> ${target}: npm drops this entry at publish (use a plain relative path such as dist/cli.js)`,
      );
    else if (!files.includes(target)) problems.push(`${spec.name}: bin ${name} -> ${target} is not in the tarball`);
  }
  if (spec.name === "@duskfleet/web" && !files.includes(".next/BUILD_ID")) {
    const msg = `${spec.name}: no dashboard build in the tarball (run npm run build:web)`;
    if (requireWebBuild) problems.push(msg);
    else warnings.push(msg);
  }
  console.log(
    `check-pack: ${report.filename} ${kb(report.size)} packed, ${kb(report.unpackedSize)} unpacked, ${files.length} files`,
  );
}

if (new Set(versions.values()).size > 1) {
  problems.push(
    `versions differ: ${[...versions].map(([n, v]) => `${n}@${v}`).join(", ")} (bump both packages together)`,
  );
}

for (const w of warnings) console.warn(`check-pack: warning: ${w}`);
if (problems.length) {
  console.error(`check-pack: ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-pack: both tarballs clean, version ${[...versions.values()][0]}`);

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} kB`;
}
