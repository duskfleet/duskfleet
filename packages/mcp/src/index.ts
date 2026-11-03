#!/usr/bin/env node
// Bin entry of the MCP server: answer `--version` (needs nothing), then check the Node version
// before anything pulls `node:sqlite`. The server entry itself is server-main.ts.
import { checkNodeVersion } from "./node-version.js";
import { handleVersionFlag } from "./version.js";

handleVersionFlag(process.argv.slice(2));
checkNodeVersion();
await import("./server-main.js");
