#!/usr/bin/env node
// Saves a repository's GitHub traffic before GitHub forgets it: the traffic API keeps views,
// clones, referrers and popular paths for 14 days only. One run writes one dated JSON file with
// the four endpoints' answers; a weekly schedule therefore keeps every day (docs/development.md
// "Traffic snapshots"). Reads through the local `gh` login only: no token in the repo or config.
//
//   node scripts/traffic-snapshot.mjs [--repo <owner/name>] [--out <dir>]
//
// The file is <out>/<owner>/<name>/<YYYY-MM-DD>.json (UTC date, default out: data/traffic,
// git-ignored). A second run on the same day overwrites that day's file: the later answer covers
// the same 14 days plus the hours since the first one. The traffic API needs push access to the
// repository; without a login, with a bad token or a read-only one the script exits 1 naming
// the cause.
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO = "duskfleet/duskfleet";
const ENDPOINTS = {
  views: "traffic/views",
  clones: "traffic/clones",
  referrers: "traffic/popular/referrers",
  paths: "traffic/popular/paths",
};

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const value = args[i + 1];
  if (!value || value.startsWith("--")) fail(`${name} expects a value`);
  return value;
}
function fail(message) {
  console.error(`traffic-snapshot: ${message}`);
  process.exit(1);
}

const repo = flag("--repo", DEFAULT_REPO);
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`--repo expects owner/name, got "${repo}"`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, flag("--out", join("data", "traffic")));

// One `gh api` call; an HTTP or login failure becomes a message naming the cause.
function ghApi(path) {
  try {
    return JSON.parse(
      execFileSync("gh", ["api", path], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024,
      }),
    );
  } catch (error) {
    if (error.code === "ENOENT") fail("gh is not installed (https://cli.github.com)");
    const stderr = String(error.stderr ?? "").trim();
    if (/gh auth login/.test(stderr)) fail("gh is not logged in: run `gh auth login`");
    if (/HTTP 401/.test(stderr))
      fail(`the gh token is invalid or expired (HTTP 401 on ${path}): run \`gh auth login\``);
    // A 403 is usually the missing push access, but a rate limit answers 403 too: keep gh's text.
    if (/HTTP 403/.test(stderr))
      fail(`the gh token lacks push access to ${repo}, which the traffic API requires (${stderr})`);
    if (/HTTP 404/.test(stderr)) fail(`${repo} not found or not visible to the gh token (HTTP 404 on ${path})`);
    fail(`gh api ${path} failed: ${stderr || error.message}`);
  }
}

// Checked up front so a read-only token fails before any traffic call, with the clearest message.
const permissions = ghApi(`repos/${repo}`).permissions;
if (permissions && !permissions.push && !permissions.admin) {
  fail(`the gh token lacks push access to ${repo}, which the traffic API requires`);
}

const snapshot = { repo, taken_at: new Date().toISOString() };
for (const [key, endpoint] of Object.entries(ENDPOINTS)) {
  snapshot[key] = ghApi(`repos/${repo}/${endpoint}`);
}

const [owner, name] = repo.split("/");
const dir = join(outDir, owner, name);
const file = join(dir, `${snapshot.taken_at.slice(0, 10)}.json`);
mkdirSync(dir, { recursive: true });
// Write then rename: an interrupted run never leaves a half-written day behind.
writeFileSync(`${file}.tmp`, `${JSON.stringify(snapshot, null, 2)}\n`);
renameSync(`${file}.tmp`, file);
console.log(
  `${repo}: ${snapshot.views.count} views, ${snapshot.clones.count} clones, ${snapshot.referrers.length} referrers, ${snapshot.paths.length} paths -> ${file}`,
);
