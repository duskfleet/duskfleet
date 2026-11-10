/**
 * `duskfleet projects` for a human: where runs may go (`allowed_project_roots`), then one table row
 * per registered project with the agents bound to it.
 */
import type { ProjectDefinition } from "@duskfleet/core";
import { type Cell, type Column, type RenderOpts, section, sections, table } from "./primitives.js";
import { paint } from "./theme.js";

export interface ProjectList {
  allowedProjectRoots: readonly string[];
  projects: readonly ProjectDefinition[];
}

const COLUMNS: readonly Column[] = [{ header: "id" }, { header: "path" }, { header: "agents", flex: true }];

/** `agents`: the loaded agents, to list the ones bound to each project (`project:` in their file). */
export function renderProjects(
  value: ProjectList,
  agents: readonly { id: string; project?: string | undefined }[],
  opts: RenderOpts,
): string[] {
  const roots = section(
    "Allowed project roots",
    value.allowedProjectRoots.length > 0 ? [...value.allowedProjectRoots] : [paint("faint", "any directory", opts)],
    opts,
  );
  if (value.projects.length === 0) {
    return sections([
      roots,
      ["no projects registered: run --project also takes a path, or add an id to projects.yaml"],
    ]);
  }
  const rows = value.projects.map((p): Cell[] => {
    const bound = agents.filter((a) => a.project === p.id).map((a) => a.id);
    return [{ text: p.id, role: "accent" }, p.path, bound.length ? bound.join(", ") : { text: "-", role: "faint" }];
  });
  return sections([roots, table(COLUMNS, rows, opts)]);
}
