/**
 * The Runs filters' scope (agents x projects) on top of core's runs.list, which filters on one
 * agent and one project. Pure, so the merge is testable without the live services.
 */

/**
 * The values of one scope dimension; `[undefined]` = no filter on it. De-duplicated: two project
 * ids registered on one path must not ask for (and list) the same runs twice.
 */
export function scopeList(one: string | undefined, many: string[] | undefined): Array<string | undefined> {
  if (many?.length) return [...new Set(many)];
  return [one];
}

/**
 * Asks once per (agent, project) pair and keeps the newest `limit` of the merged lists: the
 * newest N of the union are the newest N of the per-pair top-N lists.
 */
export function listScoped<R extends { createdAt: string }>(
  agentIds: Array<string | undefined>,
  projectPaths: Array<string | undefined>,
  limit: number,
  listPair: (agentId: string | undefined, projectPath: string | undefined) => R[],
): R[] {
  const list: R[] = [];
  for (const agentId of agentIds) {
    for (const projectPath of projectPaths) list.push(...listPair(agentId, projectPath));
  }
  if (agentIds.length * projectPaths.length <= 1) return list;
  list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return list.slice(0, limit);
}
