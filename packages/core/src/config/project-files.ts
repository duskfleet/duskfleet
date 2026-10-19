/**
 * Writing to the private project registry (user_projects_file, default
 * data/projects.yaml). Used when a link agent points at a folder that is not a
 * registered project yet: the folder becomes a project so the agent can be
 * bound to it and runs know their cwd.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

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

/** Adds (or replaces) one entry and rewrites the file, keeping the others. */
export function upsertUserProject(file: string, entry: UserProjectEntry): void {
  if (!PROJECT_ID_PATTERN.test(entry.id)) throw new Error(`invalid project id "${entry.id}"`);
  const projects = readUserProjects(file);
  const { id, ...rest } = entry;
  const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  projects[id] = clean as Omit<UserProjectEntry, "id">;
  mkdirSync(path.dirname(file), { recursive: true });
  const header = "# Private project registry (git-ignored). Same syntax as config/projects.yaml.\n";
  writeFileSync(file, header + stringifyYaml({ projects }), "utf8");
}
