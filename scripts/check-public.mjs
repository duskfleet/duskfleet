#!/usr/bin/env node
/**
 * Public-repo hygiene gate (PLAN.md §8, CLAUDE.md "This repo is public").
 *
 * Fails when a versioned file contains a home directory path, the current user's name or
 * host name, or when the index holds a symbolic link (a symlink to an absolute path leaked
 * a home directory once). Runs on `git ls-files`, so untracked and ignored files such as
 * data/, notes/ and .mcp.json are never inspected.
 *
 * Usage: node scripts/check-public.mjs      (exit 1 with a list of offending lines)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

// Patterns that are wrong in any versioned file, regardless of who committed them.
const patterns = [
  { re: /\/Users\/[A-Za-z0-9._-]+/, why: "macOS home path" },
  { re: /\/home\/[A-Za-z0-9._-]+/, why: "Linux home path" },
  { re: /[A-Z]:\\Users\\[A-Za-z0-9._-]+/, why: "Windows home path" },
  { re: /\/Volumes\/[A-Za-z0-9._-]+/, why: "macOS volume path" },
];

// Values of this machine: never versioned, never hard-coded here (the script itself is public).
const local = [];
const user = userInfo().username;
if (user && user.length >= 4) local.push({ re: new RegExp(escapeRegExp(user), "i"), why: "current user name" });
const host = hostname().replace(/\.local$/, "");
if (host && host.length >= 4) local.push({ re: new RegExp(escapeRegExp(host), "i"), why: "this machine's host name" });

// Placeholders docs are allowed to use.
const allowed = [
  /\/Users\/<[^>]+>/,
  /\/home\/<[^>]+>/,
  /\\Users\\<[^>]+>/,
  /\/Users\/(you|me)\b/,
  /\/home\/(you|me)\b/,
  /\\Users\\(you|me)\b/,
];

const binary = /\.(png|jpg|jpeg|gif|ico|webp|woff2?|ttf|db|sqlite|pdf|zip)$/i;
const problems = [];

const index = execFileSync("git", ["ls-files", "-s", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .map((line) => {
    const [meta, file] = line.split("\t");
    return { mode: meta.split(" ")[0], file };
  });

for (const { mode, file } of index) {
  if (mode === "120000") {
    problems.push(`${file}: symbolic link in the index (links to machine paths leak; commit the target or ignore it)`);
    continue;
  }
  if (binary.test(file)) continue;
  let text;
  try {
    text = readFileSync(`${root}/${file}`, "utf8");
  } catch {
    continue; // deleted in the working tree
  }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (allowed.some((a) => a.test(line))) return;
    for (const p of [...patterns, ...local]) {
      if (p.re.test(line)) {
        problems.push(`${file}:${i + 1}: ${p.why}: ${line.trim().slice(0, 120)}`);
        break;
      }
    }
  });
}

if (problems.length) {
  console.error(`check-public: ${problems.length} problem(s) in versioned files:\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "\nMove machine-specific values to data/, .mcp.json or notes/ (all git-ignored), or use a <placeholder>.",
  );
  process.exit(1);
}
console.log(`check-public: ${index.length} versioned files, no home paths, user or host names, no symlinks.`);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
