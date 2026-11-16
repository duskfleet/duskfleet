/**
 * Skills an agent declares in its frontmatter (`skills: [name, ...]`, issue #48).
 *
 * A skill is a Duskfleet-owned folder with a `SKILL.md`, found by name in two places, mirroring
 * agents: `<data_dir>/skills/<name>/` (private, git-ignored) wins over `<config>/skills/<name>/`
 * (committable). No paths, URLs or git refs: an agent file names skills, it never fetches them.
 * The target project's own `.claude/skills/` needs nothing from here (the run's cwd is the project).
 *
 * Delivery: a content-addressed bundle `<data_dir>/skill-bundles/<id>/.claude/skills/<name>`, each
 * entry a copy of the files that were hashed (never a link to the live folder, so the bundle is
 * immutable and matches its id even when the source is edited mid-run), passed to the run with
 * `--add-dir <bundle>`. Claude Code lists skills from an added directory that *contains*
 * `.claude/skills/`, not from the skills folder itself (verified 2026-11-04, Claude Code 2.1.318).
 * The project is never written. `<id>` hashes the sorted (name, content digest) list, so an edited
 * skill gives the next run a new bundle and the run row (`runs.skills_bundle`) names what it had.
 *
 * Symlinks inside a skill folder fail closed: a symlinked SKILL.md does not resolve, and any other
 * symlinked entry refuses the create / update (it would escape the lint and the digest); at run
 * start such an entry is neither hashed nor copied.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { type AgentLintProblem, lintText } from "./agent-lint.js";
import type { DuskFleetConfig } from "./types.js";

export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const SKILL_NAME_MESSAGE = "skill names are lowercase letters, digits or - (a folder under skills/)";

export type SkillSource = "user" | "builtin";

export interface ResolvedSkill {
  name: string;
  /** The folder that holds SKILL.md. */
  dir: string;
  source: SkillSource;
}

type SkillDirs = Pick<DuskFleetConfig, "configDir" | "dataDir">;

/** Where skills are looked up, first match wins: the private one, then the committable one. */
export function skillSearchDirs(config: SkillDirs): { user: string; builtin: string } {
  return { user: path.join(config.dataDir, "skills"), builtin: path.join(config.configDir, "skills") };
}

/** The skill folder for `name`, or null when neither directory has `<name>/SKILL.md`. */
export function resolveSkill(config: SkillDirs, name: string): ResolvedSkill | null {
  if (!SKILL_NAME_PATTERN.test(name)) return null;
  const dirs = skillSearchDirs(config);
  for (const source of ["user", "builtin"] as const) {
    const dir = path.join(dirs[source], name);
    if (isRegularFile(path.join(dir, "SKILL.md"))) return { name, dir, source };
  }
  return null;
}

/**
 * Create / update check (`assertAgentWritable`): every declared skill exists, and its files carry
 * no home paths or secret-looking values (the same rules as the agent file, `lintText`).
 */
export function assertSkillsAvailable(names: readonly string[], config: SkillDirs, home: string = homedir()): void {
  const missing: string[] = [];
  const problems: AgentLintProblem[] = [];
  const links: string[] = [];
  for (const name of names) {
    const skill = resolveSkill(config, name);
    if (!skill) {
      missing.push(name);
      continue;
    }
    for (const rel of skillLinks(skill.dir)) links.push(`skills/${name}/${rel.split(path.sep).join("/")}`);
    for (const rel of skillFiles(skill.dir)) {
      const text = readFileSync(path.join(skill.dir, rel), "utf8");
      problems.push(...lintText(`skills/${name}/${rel.split(path.sep).join("/")}`, text, home));
    }
  }
  if (missing.length) {
    const dirs = skillSearchDirs(config);
    throw new Error(
      `unknown skill${missing.length > 1 ? "s" : ""} ${missing.map((n) => `"${n}"`).join(", ")}: no <name>/SKILL.md in ${dirs.user} or ${dirs.builtin}`,
    );
  }
  if (links.length) {
    throw new Error(
      `skill folders must not contain symlinks (they would escape the public-repo check and the bundle hash): ${links.join(", ")}. Copy the file into the skill folder instead.`,
    );
  }
  if (problems.length) {
    const list = problems.map((p) => `${p.field}: ${p.why} (${p.excerpt})`).join("; ");
    throw new Error(
      `skill files must stay fit for a public repo, like agent files. ${list}. Use ~/... or a <placeholder> instead of a home path, and keep secrets in the environment.`,
    );
  }
}

/**
 * Relative paths of the regular files under a skill folder, sorted, dot-entries included. Symlinks
 * are never followed: these are exactly the files linted, hashed and copied into a bundle.
 */
function skillFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of sortedEntries(dir, rel)) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...skillFiles(dir, child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/** Relative paths of the symlinks under a skill folder (refused on create / update). */
function skillLinks(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of sortedEntries(dir, rel)) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...skillLinks(dir, child));
    else if (entry.isSymbolicLink()) out.push(child);
  }
  return out;
}

function sortedEntries(dir: string, rel: string) {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** sha256 over every file of a skill folder (relative path + content). */
function skillDigest(dir: string): string {
  const h = createHash("sha256");
  for (const rel of skillFiles(dir)) {
    h.update(rel.split(path.sep).join("/"));
    h.update("\0");
    h.update(
      createHash("sha256")
        .update(readFileSync(path.join(dir, rel)))
        .digest("hex"),
    );
    h.update("\n");
  }
  return h.digest("hex");
}

export interface SkillBundle {
  /** Content hash of the sorted (name, digest) list; `runs.skills_bundle`. */
  id: string;
  /** The directory passed with --add-dir (it contains `.claude/skills/`). */
  dir: string;
  /** The skills in the bundle, in name order. */
  skills: ResolvedSkill[];
  /** Declared names found in neither skills directory (deleted since the agent was written). */
  missing: string[];
}

/**
 * Builds (or reuses) the bundle for `names`. Null when none of them resolves. Built in a temporary
 * directory and renamed into place, so a concurrent run sees either nothing or a complete bundle.
 */
export function prepareSkillBundle(config: SkillDirs, names: readonly string[]): SkillBundle | null {
  const unique = [...new Set(names)].sort();
  const skills: ResolvedSkill[] = [];
  const missing: string[] = [];
  for (const name of unique) {
    const s = resolveSkill(config, name);
    if (s) skills.push(s);
    else missing.push(name);
  }
  if (!skills.length) return null;
  const h = createHash("sha256");
  // Bundle format: 2 = copied files (1 linked to the live folders); a new format never reuses an old bundle.
  h.update("bundle-format 2\n");
  for (const s of skills) h.update(`${s.name}\0${skillDigest(s.dir)}\n`);
  const id = h.digest("hex").slice(0, 16);
  const root = path.join(config.dataDir, "skill-bundles");
  const dir = path.join(root, id);
  if (!bundleComplete(dir, skills)) {
    const tmp = path.join(root, `.${id}.${process.pid}.${Date.now()}`);
    const skillsDir = path.join(tmp, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    for (const s of skills) {
      const target = path.join(skillsDir, s.name);
      for (const rel of skillFiles(s.dir)) {
        mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
        copyFileSync(path.join(s.dir, rel), path.join(target, rel));
      }
    }
    installBundle(tmp, dir, skills);
  }
  return { id, dir, skills, missing };
}

/**
 * Renames the freshly built `tmp` into `dir` without ever deleting a bundle another process may
 * have just installed (and passed to a run with --add-dir): rename first; only when `dir` is
 * taken by an incomplete bundle is that one moved aside under a unique name, then the rename is
 * retried once. A complete `dir` (a concurrent run built the same bundle) is as good as ours.
 */
function installBundle(tmp: string, dir: string, skills: ResolvedSkill[]): void {
  try {
    renameSync(tmp, dir);
    return;
  } catch (err) {
    if (bundleComplete(dir, skills) || !existsSync(dir)) {
      rmSync(tmp, { recursive: true, force: true });
      if (bundleComplete(dir, skills)) return;
      throw err;
    }
  }
  const aside = `${dir}.stale.${process.pid}.${Date.now()}`;
  try {
    renameSync(dir, aside);
  } catch {
    // Another process moved it aside first; the retry below decides.
  }
  try {
    renameSync(tmp, dir);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    if (!bundleComplete(dir, skills)) throw err;
  } finally {
    rmSync(aside, { recursive: true, force: true });
  }
}

function bundleComplete(dir: string, skills: ResolvedSkill[]): boolean {
  return skills.every((s) => isFile(path.join(dir, ".claude", "skills", s.name, "SKILL.md")));
}

/** Bundled skills the project also defines in `.claude/skills/`: the project's wins (Claude Code's precedence). */
export function skillsShadowedByProject(projectPath: string, names: readonly string[]): string[] {
  return names.filter((n) => existsSync(path.join(projectPath, ".claude", "skills", n)));
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** A file that is not a symlink (the skill folder itself may be one; its SKILL.md may not). */
function isRegularFile(p: string): boolean {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}
