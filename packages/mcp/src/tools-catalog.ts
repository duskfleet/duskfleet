#!/usr/bin/env node
/**
 * Tool catalogue: the MCP server's own tools/list answer, serialised to JSON.
 *
 * The dashboard renders this (packages/mcp/dist/tools.json, written at build
 * time) without depending on the mcp package, and `duskfleet tools` prints it.
 * Because it comes from the real registrations through the real SDK, it cannot
 * drift from what Claude Desktop sees.
 */
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, SERVER_INSTRUCTIONS, SERVER_VERSION, type ToolContext } from "./mcp/server.js";

export interface ToolCatalogEntry {
  name: string;
  title: string | null;
  description: string;
  /** JSON Schema of the input, as advertised to clients. */
  inputSchema: unknown;
  /** Coarse grouping for the docs page, derived from the name. */
  group: "runs" | "agents" | "schedules" | "projects" | "other";
}

export interface ToolCatalog {
  generatedAt: string;
  server: { name: string; version: string; instructions: string };
  tools: ToolCatalogEntry[];
}

function groupOf(name: string): ToolCatalogEntry["group"] {
  if (/schedule/.test(name)) return "schedules";
  if (/^(run_agent|get_run|list_runs|cancel_run)$/.test(name)) return "runs";
  if (/project/.test(name)) return "projects";
  if (/agent/.test(name)) return "agents";
  return "other";
}

/** Registration never touches the context, so an empty one is enough to list tools. */
export async function buildToolCatalog(): Promise<ToolCatalog> {
  const server = createMcpServer({} as ToolContext);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "catalog", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return {
      generatedAt: new Date().toISOString(),
      server: { name: "duskfleet", version: SERVER_VERSION, instructions: SERVER_INSTRUCTIONS },
      tools: tools
        .map((t) => ({
          name: t.name,
          title: (t as { title?: string }).title ?? null,
          description: t.description ?? "",
          inputSchema: t.inputSchema,
          group: groupOf(t.name),
        }))
        .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name)),
    };
  } finally {
    await client.close();
    await server.close();
  }
}

// CLI entry: `node dist/tools-catalog.js [--write <file>]`
const invokedDirectly = process.argv[1]?.endsWith("tools-catalog.js");
if (invokedDirectly) {
  buildToolCatalog()
    .then((catalog) => {
      const i = process.argv.indexOf("--write");
      const json = JSON.stringify(catalog, null, 2);
      const out = i >= 0 ? process.argv[i + 1] : undefined;
      if (out) {
        writeFileSync(out, json + "\n");
        process.stderr.write(`wrote ${catalog.tools.length} tools to ${out}\n`);
      } else {
        process.stdout.write(json + "\n");
      }
    })
    .catch((err) => {
      process.stderr.write(`tools-catalog failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
