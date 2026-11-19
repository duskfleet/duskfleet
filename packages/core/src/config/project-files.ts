/**
 * Writing to the private project registry (user_projects_file, default
 * data/projects.yaml). Used when a link agent points at a folder that is not a
 * registered project yet: the folder becomes a project so the agent can be
 * bound to it and runs know their cwd.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { collapseHome } from "./agent-lint.js";

export interface UserProjectEntry {
  id: string;
  path: string;
  description?: string;
  inherit_mcp?: boolean;
  add_dirs?: string[];
}

export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

/** "My App Repo" → "my-app-repo"; falls back to "project" when nothing usable is left. */
export function projectIdFromPath(dir: string): string {
  const base = path
    .basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "project";
}

export function readUserProjects(file: string): Record<string, Omit<UserProjectEntry, "id">> {
  if (!existsSync(file)) return {};
  const raw = parseYaml(readFileSync(file, "utf8")) ?? {};
  const projects = (raw as { projects?: unknown }).projects;
  return projects && typeof projects === "object" ? (projects as Record<string, Omit<UserProjectEntry, "id">>) : {};
}

const realOrRaw = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * Same directory? validateProjectPath returns a realpath, the loader only path.resolve's the
 * registry entries (and expands `~`): an entry stored through a symlink (/tmp on macOS) or as
 * `~/...` under a symlinked home must still match.
 */
export const sameDirectory = (a: string, b: string): boolean => a === b || realOrRaw(a) === realOrRaw(b);

/**
 * `<home>/x` → `~/x` for a registry entry, like agent files' add_dirs. Also tried against the
 * home's realpath, since callers pass a realpath (validateProjectPath). The loader expands it again.
 */
export function registryPath(p: string, home: string = homedir()): string {
  const collapsed = collapseHome(p, home);
  return collapsed !== p || !home ? collapsed : collapseHome(p, realOrRaw(home));
}

/**
 * Adds (or replaces) one entry and rewrites the file, keeping the others. A path under the home
 * directory is stored as `~/...` (registryPath), never as a machine path.
 */
export function upsertUserProject(file: string, entry: UserProjectEntry): void {
  if (!PROJECT_ID_PATTERN.test(entry.id)) throw new Error(`invalid project id "${entry.id}"`);
  const projects = readUserProjects(file);
  const { id, ...rest } = { ...entry, path: registryPath(entry.path) };
  const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  projects[id] = clean as Omit<UserProjectEntry, "id">;
  mkdirSync(path.dirname(file), { recursive: true });
  const header = "# Private project registry (git-ignored). Same syntax as config/projects.yaml.\n";
  writeFileSync(file, header + stringifyYaml({ projects }), "utf8");
}
