import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { cliCommand, cliPrefix, detectInstall, installServiceCommand } from "../lib/cli.ts";

const REPO = path.resolve("/work/duskfleet");
const GLOBAL_ENTRY = path.resolve("/usr/local/lib/node_modules/duskfleet/dist/index.js");
const NPX_ENTRY = path.resolve("/home/u/.npm/_npx/abc123/node_modules/duskfleet/dist/index.js");

/** Facts for detectInstall over an in-memory file list: path -> package.json version (or true). */
function facts(files, overrides = {}) {
  const exists = (f) => Object.hasOwn(files, path.resolve(f));
  return {
    cwd: path.resolve("/tmp/somewhere"),
    findRepoRoot: (from) => {
      let dir = path.resolve(from);
      for (;;) {
        if (exists(path.join(dir, "config", "duskfleet.yaml"))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
      }
    },
    exists,
    readVersion: (f) => {
      const v = files[path.resolve(f)];
      return typeof v === "string" ? v : null;
    },
    ...overrides,
  };
}

const checkoutFiles = {
  [path.join(REPO, "config", "duskfleet.yaml")]: true,
  [path.join(REPO, "packages", "mcp", "package.json")]: "0.1.0",
  [path.join(REPO, "packages", "mcp", "dist", "index.js")]: true,
};

test("detectInstall: npm run web inside the checkout is the checkout form", () => {
  const install = detectInstall(facts(checkoutFiles, { cwd: path.join(REPO, "apps", "web") }));
  assert.equal(install.form, "checkout");
  assert.equal(install.mcpEntry, path.join(REPO, "packages", "mcp", "dist", "index.js"));
  assert.equal(install.version, "0.1.0");
});

test("detectInstall: the CLI's entry inside a checkout wins over the working directory", () => {
  const install = detectInstall(
    facts(checkoutFiles, { mcpEntryEnv: path.join(REPO, "packages", "mcp", "dist", "index.js") }),
  );
  assert.equal(install.form, "checkout");
});

test("detectInstall: a config/ root without the MCP sources is not a checkout", () => {
  const userDir = path.resolve("/home/u/project");
  const install = detectInstall(
    facts(
      {
        [path.join(userDir, "config", "duskfleet.yaml")]: true,
        [GLOBAL_ENTRY]: true,
        [path.resolve(GLOBAL_ENTRY, "..", "..", "package.json")]: "0.2.0",
      },
      { cwd: userDir, mcpEntryEnv: GLOBAL_ENTRY },
    ),
  );
  assert.equal(install.form, "global");
  assert.equal(install.mcpEntry, GLOBAL_ENTRY);
  assert.equal(install.version, "0.2.0");
});

test("detectInstall: an entry in npx's cache is the npx form, pinned to its version", () => {
  const install = detectInstall(
    facts(
      { [NPX_ENTRY]: true, [path.resolve(NPX_ENTRY, "..", "..", "package.json")]: "0.1.0" },
      { mcpEntryEnv: NPX_ENTRY },
    ),
  );
  assert.equal(install.form, "npx");
  assert.equal(install.mcpEntry, NPX_ENTRY);
  assert.equal(install.version, "0.1.0");
});

test("detectInstall: without the CLI, a duskfleet package next to @duskfleet/web is found", () => {
  const webDir = path.resolve("/usr/local/lib/node_modules/@duskfleet/web");
  const install = detectInstall(
    facts({ [GLOBAL_ENTRY]: true, [path.join(webDir, "package.json")]: "0.1.0" }, { webDir }),
  );
  assert.equal(install.form, "global");
  assert.equal(install.mcpEntry, GLOBAL_ENTRY);
  assert.equal(install.version, "0.1.0");
});

test("detectInstall: no entry anywhere leaves mcpEntry null, never a placeholder", () => {
  const install = detectInstall(facts({}));
  assert.equal(install.form, "global");
  assert.equal(install.mcpEntry, null);
  assert.equal(install.version, "unknown");
});

test("cliCommand renders the command of each install form", () => {
  assert.equal(cliCommand({ form: "checkout", version: "0.1.0" }, "schedules"), "npm run cli -- schedules");
  assert.equal(cliCommand({ form: "global", version: "0.1.0" }, "schedules"), "duskfleet schedules");
  assert.equal(cliCommand({ form: "npx", version: "0.1.0" }, "schedules"), "npx -y duskfleet@0.1.0 schedules");
  assert.equal(cliPrefix({ form: "global", version: "0.1.0" }), "duskfleet");
});

test("installServiceCommand: npx installs the package first, since install-service refuses the cache", () => {
  assert.equal(installServiceCommand({ form: "checkout", version: "0.1.0" }), "npm run cli -- install-service");
  assert.equal(installServiceCommand({ form: "global", version: "0.1.0" }), "duskfleet install-service");
  assert.equal(
    installServiceCommand({ form: "npx", version: "0.1.0" }),
    "npm install -g duskfleet@0.1.0 && duskfleet install-service",
  );
});
