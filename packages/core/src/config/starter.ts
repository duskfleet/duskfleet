/**
 * Starter configuration: the files a fresh user-level config directory begins with, a
 * `duskfleet.yaml` and the `example` agent. They ship as templates next to core's code
 * (`packages/core/templates` in the repository, `dist/templates` in the published package) and
 * are copied by `writeStarterConfig`; the command that calls it (`duskfleet init`) lives in the CLI.
 * The repository's own `config/agents/example.md` is the same file (a test pins it).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Id of the starter agent, the one the README Quick start runs. */
export const STARTER_AGENT_ID = "example";

/**
 * Directory holding the starter templates. Resolved lazily from this module's location: two
 * levels up from `config/starter.js` is `packages/core/` in the repository and `dist/` in the
 * bundle, where `scripts/assemble-package.mjs` copies the templates.
 */
export function starterTemplatesDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");
}

export interface StarterResult {
  configDir: string;
  /** Absolute paths written by this call. */
  created: string[];
  /** Absolute paths that already existed and were left untouched. */
  kept: string[];
}

/**
 * Copies the starter files into `configDir` (created if missing). Never overwrites: a file that
 * already exists is reported in `kept`, so a second call changes nothing.
 */
export function writeStarterConfig(configDir: string, templatesDir: string = starterTemplatesDir()): StarterResult {
  if (!existsSync(path.join(templatesDir, "duskfleet.yaml"))) {
    throw new Error(`starter templates not found in ${templatesDir}`);
  }
  const target = path.resolve(configDir);
  const result: StarterResult = { configDir: target, created: [], kept: [] };
  for (const rel of templateFiles(templatesDir)) {
    const dest = path.join(target, rel);
    if (existsSync(dest)) {
      result.kept.push(dest);
      continue;
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(templatesDir, rel), dest);
    result.created.push(dest);
  }
  return result;
}

/** Relative paths of every file under the templates directory, sorted. */
function templateFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...templateFiles(dir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}
