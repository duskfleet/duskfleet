#!/usr/bin/env node
// Bin entry of the CLI: answer `--version` (needs nothing), then check the Node version before
// anything pulls `node:sqlite`. The CLI itself is cli-main.ts.
import { checkNodeVersion } from "./node-version.js";
import { handleVersionFlag } from "./version.js";

handleVersionFlag(process.argv.slice(2));
checkNodeVersion();
await import("./cli-main.js");
