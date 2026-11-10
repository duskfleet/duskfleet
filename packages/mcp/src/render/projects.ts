/**
 * `duskfleet projects` for a human (DS-33): where runs may go (`allowed_project_roots`) in the
 * header, then one row per registered project with the agents bound to it (`+n` when they do not
 * fit). The home directory reads `~`.
 */
import type { ProjectDefinition } from "@duskfleet/core";
import { type Cell, type Column, emptyState, jsonLine, type RenderOpts, table, tildePath } from "./primitives.js";
import { paint } from "./theme.js";

export interface ProjectList {
  allowedProjectRoots: readonly string[];
  projects: readonly ProjectDefinition[];
}

const ID = 12;
const PATH = 30;

const COLUMNS: readonly Column[] = [
  { header: "ID", width: ID },
  { header: "PATH", width: PATH, flex: true, truncate: "middle" },
  { header: "AGENTS", fill: true },
];

/** `a, b, +3`: as many names as fit in `room`, the rest counted. */
function agentList(names: readonly string[], room: number): string {
  if (names.length === 0) return "none";
  const all = names.join(", ");
  if (all.length <= room) return all;
  for (let n = names.length - 1; n >= 1; n--) {
    const text = `${names.slice(0, n).join(", ")}, +${names.length - n}`;
    if (text.length <= room) return text;
  }
  return `+${names.length}`;
}

/** `agents`: the loaded agents, to list the ones bound to each project (`project:` in their file). */
export function renderProjects(
  value: ProjectList,
  agents: readonly { id: string; project?: string | undefined }[],
  opts: RenderOpts,
  home?: string,
): string[] {
  const roots = value.allowedProjectRoots.length
    ? value.allowedProjectRoots.map((r) => tildePath(r, home)).join(", ")
    : "any directory";
  const head = `${paint("heading", "projects", opts)} · allowed roots: ${roots}`;
  if (value.projects.length === 0) {
    return [head, "", ...emptyState("no projects registered", "duskfleet run --project <absolute path> ...", opts)];
  }
  const room = Math.max(6, opts.width - ID - PATH - 4);
  const rows = value.projects.map((p): Cell[] => {
    const bound = agents.filter((a) => a.project === p.id).map((a) => a.id);
    return [{ text: p.id, role: "accent" }, tildePath(p.path, home), agentList(bound, room)];
  });
  return [head, "", ...table(COLUMNS, rows, opts), "", jsonLine(opts, "register more in projects.yaml")];
}
