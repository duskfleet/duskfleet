import { logger } from "@duskfleet/core";
/**
 * Duskfleet MCP server entry point (stdio transport).
 *
 * stdout is the protocol channel; all logging goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bootstrap } from "./bootstrap.js";
import { createMcpServer } from "./mcp/server.js";

const log = logger("mcp");

async function main(): Promise<void> {
  const app = await bootstrap(import.meta.url, { role: "mcp" });

  let version: string | null = null;
  try {
    version = await app.executor.version();
  } catch (err) {
    log.warn("could not read claude version", { err: String(err) });
  }

  const server = createMcpServer({
    get config() {
      return app.runs.reloadConfig();
    },
    runs: app.runs,
    scheduler: app.scheduler,
    executorInfo: { name: app.executor.name, binary: app.executor.binary, version },
  });
  // The host (Claude Desktop, Claude Code) keeps this process alive, so it can tick.
  // If a `duskfleet serve` is also running, the SQLite lease decides who fires.
  app.scheduler.start();

  const shutdown = (reason: string) => {
    log.info(`shutting down (${reason})`);
    app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.stdin.on("close", () => shutdown("stdin closed"));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("Duskfleet MCP server listening on stdio", { claude: version });
}

main().catch((err) => {
  log.error("fatal", { err: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  process.exit(1);
});
