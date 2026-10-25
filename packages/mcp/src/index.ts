#!/usr/bin/env node
// Bin entry of the MCP server: check the Node version before anything pulls `node:sqlite`.
// The server entry itself is server-main.ts.
import { checkNodeVersion } from "./node-version.js";

checkNodeVersion();
await import("./server-main.js");
