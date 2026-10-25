#!/usr/bin/env node
// Bin entry of the CLI: check the Node version before anything pulls `node:sqlite`.
// The CLI itself is cli-main.ts.
import { checkNodeVersion } from "./node-version.js";

checkNodeVersion();
await import("./cli-main.js");
