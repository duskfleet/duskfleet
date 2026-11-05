/**
 * Skills an agent declares in its frontmatter (`skills: [name, ...]`, issue #48).
 *
 * A skill is a Duskfleet-owned folder with a `SKILL.md`, found by name in two places, mirroring
 * agents: `<data_dir>/skills/<name>/` (private, git-ignored) wins over `<config>/skills/<name>/`
 * (committable). No paths, URLs or git refs: an agent file names skills, it never fetches them.
 * The target project's own `.claude/skills/` needs nothing from here (the run's cwd is the project).
 *
 * Delivery: a content-addressed bundle `<data_dir>/skill-bundles/<id>/.claude/skills/<name>`, each
 * entry a symlink (a copy on Windows) to the source folder, passed to the run with `--add-dir
 * <bundle>`. Claude Code lists skills from an added directory that *contains* `.claude/skills/`,
 * not from the skills folder itself (verified 2026-11-04, Claude Code 2.1.318). The project is
 * never written. `<id>` hashes the sorted (name, content digest) list, so an edited skill gives
 * the next run a new bundle and the run row (`runs.skills_bundle`) names what was available.
 */
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
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
    if (isFile(path.join(dir, "SKILL.md"))) return { name, dir, source };
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
  for (const name of names) {
    const skill = resolveSkill(config, name);
    if (!skill) {
      missing.push(name);
      continue;
    }
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
  if (problems.length) {
    const list = problems.map((p) => `${p.field}: ${p.why} (${p.excerpt})`).join("; ");
    throw new Error(
      `skill files must stay fit for a public repo, like agent files. ${list}. Use ~/... or a <placeholder> instead of a home path, and keep secrets in the environment.`,
    );
  }
}

/** Relative paths of the files under a skill folder, sorted, dot-entries included, symlinks not followed out. */
function skillFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  const here = path.join(dir, rel);
  for (const entry of readdirSync(here, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...skillFiles(dir, child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
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
      if (process.platform === "win32") cpSync(s.dir, target, { recursive: true });
      else symlinkSync(s.dir, target, "dir");
    }
    rmSync(dir, { recursive: true, force: true });
    try {
      renameSync(tmp, dir);
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      // Another process renamed the same bundle into place first: that one is as good as ours.
      if (!bundleComplete(dir, skills)) throw err;
    }
  }
  return { id, dir, skills, missing };
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
