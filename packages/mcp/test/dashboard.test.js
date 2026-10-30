/**
 * `duskfleet dashboard`: installs @duskfleet/web at the CLI's own version under
 * <dataDir>/web/<version>, starts it in the foreground and serves /. No network: the package is a
 * tiny stand-in packed into a local tarball (DUSKFLEET_WEB_SPEC) and npm runs with offline=true.
 */
import "./helpers.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  assertPortFree,
  compareVersions,
  manualInstallHint,
  olderWebVersions,
  openerCommand,
  parsePort,
  promoteStaging,
  webInstallDir,
} from "../dist/dashboard.js";
import { testEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "dist", "cli.js");
const version = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")).version;

const root = mkdtempSync(path.join(tmpdir(), "duskfleet-dashboard-"));
after(() => rmSync(root, { recursive: true, force: true }));

// npm without network or the user's cache and global prefix.
const npmEnv = {
  npm_config_cache: path.join(root, "npm-cache"),
  npm_config_prefix: path.join(root, "npm-global"),
  npm_config_offline: "true",
  npm_config_update_notifier: "false",
  DUSKFLEET_LOG_LEVEL: "warn",
};

/** One ustar entry (header + content padded to 512 bytes), the layout `npm pack` writes. */
function tarEntry(name, content) {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  const field = (offset, length, value) => header.write(value, offset, length, "ascii");
  const octal = (offset, length, n) => field(offset, length, `${n.toString(8).padStart(length - 1, "0")}\0`);
  field(0, 100, name);
  octal(100, 8, 0o644);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, data.length);
  octal(136, 12, Math.floor(Date.now() / 1000));
  field(148, 8, "        ");
  field(156, 1, "0");
  field(257, 8, "ustar\u000000");
  let sum = 0;
  for (const byte of header) sum += byte;
  field(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

/**
 * A stand-in @duskfleet/web as a local tarball (written here: `npm pack` alone took 12 s on a
 * loaded machine): bin/start.mjs answers 200 on 127.0.0.1:$PORT with what it was given.
 */
function packFakeWeb(pkgVersion) {
  const pkg = JSON.stringify({
    name: "@duskfleet/web",
    version: pkgVersion,
    bin: { "duskfleet-web": "bin/start.mjs" },
  });
  const start = [
    'import { createServer } from "node:http";',
    "const body = JSON.stringify({ config: process.env.DUSKFLEET_CONFIG, telemetry: process.env.NEXT_TELEMETRY_DISABLED });",
    'createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(body))',
    '  .listen(Number(process.env.PORT), "127.0.0.1");',
    'process.on("SIGTERM", () => process.exit(0));',
    "",
  ].join("\n");
  const tar = Buffer.concat([
    tarEntry("package/package.json", pkg),
    tarEntry("package/bin/start.mjs", start),
    Buffer.alloc(1024),
  ]);
  const file = path.join(root, `duskfleet-web-${pkgVersion}.tgz`);
  writeFileSync(file, gzipSync(tar));
  return file;
}

function makeConfig(name) {
  const base = path.join(root, name);
  const configDir = path.join(base, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  writeFileSync(path.join(configDir, "duskfleet.yaml"), "data_dir: ../data\n");
  return { configDir, dataDir: path.join(base, "data") };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Starts `dashboard --no-open`, waits for the ready line, GETs /, stops it with `stopSignal`. */
async function startAndFetch(configDir, extraEnv, extraArgs = [], { port: fixedPort, stopSignal = "SIGTERM" } = {}) {
  const port = fixedPort ?? (await freePort());
  const child = spawn(process.execPath, [cli, "dashboard", "--no-open", "--port", String(port), ...extraArgs], {
    env: testEnv({ ...npmEnv, DUSKFLEET_CONFIG: configDir, ...extraEnv }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 60_000);
    const check = () => {
      if (stderr.includes(`dashboard: http://localhost:${port}`)) {
        clearTimeout(timer);
        resolve(true);
      }
    };
    child.stderr.on("data", check);
    exited.then(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  if (!ready) {
    child.kill("SIGKILL");
    return { ready, stderr, code: await exited };
  }
  const res = await fetch(`http://127.0.0.1:${port}/`);
  const body = await res.json();
  child.kill(stopSignal);
  const code = await exited;
  return { ready, stderr, status: res.status, body, code };
}

test("pure helpers: install dir, port flag, opener, manual hint", () => {
  assert.equal(webInstallDir("/d", "1.2.3"), path.join("/d", "web", "1.2.3"));
  assert.equal(parsePort(undefined), 4777);
  assert.equal(parsePort("8080"), 8080);
  for (const bad of ["0", "65536", "80a", "-1", ""]) assert.throws(() => parsePort(bad), /--port must be a TCP port/);
  assert.deepEqual(openerCommand("darwin", "http://localhost:1"), { bin: "open", args: ["http://localhost:1"] });
  assert.deepEqual(openerCommand("linux", "http://localhost:1"), { bin: "xdg-open", args: ["http://localhost:1"] });
  assert.equal(openerCommand("win32", "http://localhost:1").bin, "cmd");
  assert.match(manualInstallHint("1.2.3"), /npm install -g @duskfleet\/web@1\.2\.3.*duskfleet dashboard --no-install/);
});

test("version cleanup keeps newer installs, staging directories and non-versions", () => {
  assert.ok(compareVersions("0.9.0", "0.10.0") < 0);
  assert.ok(compareVersions("1.0.0-beta.2", "1.0.0-beta.10") < 0);
  assert.ok(compareVersions("1.0.0-beta", "1.0.0") < 0);
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0-alpha.1") < 0);
  assert.ok(compareVersions("1.0.0-1", "1.0.0-alpha") < 0);
  assert.equal(compareVersions("2.1.3", "2.1.3"), 0);
  assert.ok(compareVersions("2.0.0", "1.99.99") > 0);
  const dirs = [
    "0.1.0",
    "0.2.0-rc.1",
    "0.2.0",
    "0.3.0",
    "0.2.0.partial",
    "0.3.0-rc.1.partial",
    "0.1.0-x.partial",
    "notes",
  ];
  assert.deepEqual(olderWebVersions(dirs, "0.2.0"), ["0.1.0", "0.2.0-rc.1"]);
  assert.deepEqual(olderWebVersions(dirs, "not-a-version"), []);
});

/** A minimal installed @duskfleet/web of `pkgVersion` under `prefix`, as npm leaves it. */
function fakeInstall(prefix, pkgVersion, marker) {
  const pkgDir = path.join(prefix, "node_modules", "@duskfleet", "web");
  mkdirSync(path.join(pkgDir, "bin"), { recursive: true });
  writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@duskfleet/web", version: pkgVersion }));
  writeFileSync(path.join(pkgDir, "bin", "start.mjs"), `// ${marker}\n`);
  return path.join(pkgDir, "bin", "start.mjs");
}

test("promoting a staging install: reuses one a concurrent run finished first, replaces a broken leftover", () => {
  const base = path.join(root, "promote", "web");
  const target = path.join(base, "1.2.3");
  const mine = `${target}.111.partial`;
  const theirs = fakeInstall(target, "1.2.3", "theirs");
  fakeInstall(mine, "1.2.3", "mine");
  assert.equal(promoteStaging(mine, target, "1.2.3"), theirs);
  assert.match(readFileSync(theirs, "utf8"), /theirs/, "the other run's install is kept");
  assert.ok(!existsSync(mine), "our staging directory is dropped");

  rmSync(target, { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, "leftover"), "broken");
  const staged = `${target}.222.partial`;
  fakeInstall(staged, "1.2.3", "mine");
  const entry = promoteStaging(staged, target, "1.2.3");
  assert.match(readFileSync(entry, "utf8"), /mine/);
  assert.ok(!existsSync(path.join(target, "leftover")));
  assert.ok(!existsSync(staged));
  assert.deepEqual(olderWebVersions(["1.2.0.333.partial", "1.2.0"], "1.2.3"), ["1.2.0"]);
});

test("a port already in use is refused before any install, with a clear message", async () => {
  const { configDir, dataDir } = makeConfig("port-taken");
  const busy = createServer();
  await new Promise((resolve) => busy.listen(0, "127.0.0.1", resolve));
  const { port } = busy.address();
  try {
    await assert.rejects(assertPortFree(port), new RegExp(`port ${port} on 127\\.0\\.0\\.1 is already in use.*--port`));
    const r = await startAndFetch(configDir, { DUSKFLEET_WEB_SPEC: packFakeWeb(version) }, [], { port });
    assert.equal(r.ready, false, "no ready line: the URL is not printed, the browser not opened");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /is already in use/);
    assert.ok(!existsSync(path.join(dataDir, "web")), "nothing installed");
  } finally {
    await new Promise((resolve) => busy.close(resolve));
  }
  await assertPortFree(port);
});

test("first start installs @duskfleet/web at the CLI's version, serves /, drops the old version; second start installs nothing", async () => {
  const tarball = packFakeWeb(version);
  const { configDir, dataDir } = makeConfig("ok");
  const old = path.join(dataDir, "web", "0.0.0-old");
  mkdirSync(old, { recursive: true });
  // Kept: a newer install (a downgrade must not delete it) and another run's staging directory.
  const newer = path.join(dataDir, "web", "999.0.0");
  const staging = path.join(dataDir, "web", "999.0.0.4242.partial");
  mkdirSync(newer, { recursive: true });
  mkdirSync(staging, { recursive: true });

  const first = await startAndFetch(configDir, { DUSKFLEET_WEB_SPEC: tarball });
  assert.ok(first.ready, first.stderr);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { config: configDir, telemetry: "1" });
  assert.match(first.stderr, /installing .* into /);
  assert.ok(!existsSync(old), "the older version directory is removed once the new one is installed");

  const cliVersion = spawnSync(process.execPath, [cli, "--version"], {
    env: testEnv(),
    encoding: "utf8",
  }).stdout.trim();
  const installed = JSON.parse(
    readFileSync(
      path.join(webInstallDir(dataDir, cliVersion), "node_modules", "@duskfleet", "web", "package.json"),
      "utf8",
    ),
  );
  assert.equal(installed.version, cliVersion, "installed @duskfleet/web equals duskfleet --version");
  assert.deepEqual(
    readdirSync(path.join(dataDir, "web")).sort(),
    [cliVersion, "999.0.0", "999.0.0.4242.partial"].sort(),
  );
  rmSync(newer, { recursive: true });
  rmSync(staging, { recursive: true });

  // A spec that cannot install proves the second start does not try.
  const second = await startAndFetch(configDir, { DUSKFLEET_WEB_SPEC: path.join(root, "missing.tgz") });
  assert.ok(second.ready, second.stderr);
  assert.equal(second.status, 200);
  assert.doesNotMatch(second.stderr, /installing/);

  // --no-install uses the data directory install too. Stopped with Ctrl-C (SIGINT, which the
  // stand-in does not handle, so it dies by the signal): a normal stop exits 0.
  const third = await startAndFetch(configDir, {}, ["--no-install"], { stopSignal: "SIGINT" });
  assert.ok(third.ready, third.stderr);
  assert.equal(third.status, 200);
  assert.equal(third.code, 0);
});

test("a failed install exits 1 with the manual alternative and leaves no partial directory", async () => {
  const { configDir, dataDir } = makeConfig("offline");
  const r = await startAndFetch(configDir, { DUSKFLEET_WEB_SPEC: path.join(root, "missing.tgz") });
  assert.equal(r.ready, false);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not install the dashboard/);
  assert.match(r.stderr, new RegExp(`npm install -g @duskfleet/web@${version.replace(/\./g, "\\.")}`));
  assert.match(r.stderr, /duskfleet dashboard --no-install/);
  assert.deepEqual(readdirSync(path.join(dataDir, "web")), []);
});

test("a package of another version is refused, not started", async () => {
  const { configDir, dataDir } = makeConfig("mismatch");
  const r = await startAndFetch(configDir, { DUSKFLEET_WEB_SPEC: packFakeWeb("0.0.1") });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the installed package is not @duskfleet\/web@/);
  assert.deepEqual(readdirSync(path.join(dataDir, "web")), []);
});

test("--no-install with nothing installed fails with the manual alternative and installs nothing", async () => {
  const { configDir, dataDir } = makeConfig("no-install");
  const r = await startAndFetch(configDir, {}, ["--no-install"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /@duskfleet\/web@.* is not installed; install it by hand/);
  assert.ok(!existsSync(path.join(dataDir, "web")));
});
