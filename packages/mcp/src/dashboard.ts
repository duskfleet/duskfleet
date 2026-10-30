/**
 * `duskfleet dashboard`: the dashboard is the separate package `@duskfleet/web` (next, react and
 * react-dom stay out of the `duskfleet` tarball). It is installed on demand, at this CLI's own
 * version, under `<dataDir>/web/<version>/`, then started in the foreground on 127.0.0.1 with the
 * current config passed through DUSKFLEET_CONFIG.
 *
 *   <dataDir>/web/<version>/node_modules/@duskfleet/web/bin/start.mjs
 *
 * An install goes to `<version>.<pid>.partial` first (one per process) and is renamed once the
 * installed package carries the right version; when another run installed the same version in the
 * meantime, that install is reused. An older version directory stays until then, and is removed
 * after (older semver versions only: a newer install or another run's `.partial` directory is
 * never touched).
 * DUSKFLEET_WEB_SPEC replaces the npm spec (`@duskfleet/web@<version>`), e.g. a local tarball.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import path from "node:path";

export const WEB_PACKAGE = "@duskfleet/web";
export const DEFAULT_DASHBOARD_PORT = 4777;

/** Where the dashboard of `version` is installed: `<dataDir>/web/<version>`. */
export function webInstallDir(dataDir: string, version: string): string {
  return path.join(dataDir, "web", version);
}

/** Version of the `@duskfleet/web` package directory, or null when there is none. */
function packageDirVersion(pkgDir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && existsSync(path.join(pkgDir, "bin", "start.mjs")) ? pkg.version : null;
  } catch {
    return null;
  }
}

/** `bin/start.mjs` of the package installed under `prefix` when it is exactly `version`, else null. */
export function installedWebEntry(prefix: string, version: string): string | null {
  const pkgDir = path.join(prefix, "node_modules", ...WEB_PACKAGE.split("/"));
  return packageDirVersion(pkgDir) === version ? path.join(pkgDir, "bin", "start.mjs") : null;
}

/** The manual way out, in every message about a failed or refused install. */
export function manualInstallHint(version: string): string {
  return `install it by hand with "npm install -g ${WEB_PACKAGE}@${version}", then run "duskfleet dashboard --no-install"`;
}

function npmCommand(): { bin: string; shell: boolean } {
  // npm is a .cmd script on Windows: Node refuses to spawn it without a shell.
  return process.platform === "win32" ? { bin: "npm.cmd", shell: true } : { bin: "npm", shell: false };
}

function quoteForShell(arg: string): string {
  return /^[\w@./:=-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

function runNpm(args: string[], stdio: "pipe" | "progress") {
  const { bin, shell } = npmCommand();
  return spawnSync(bin, shell ? args.map(quoteForShell) : args, {
    shell,
    encoding: "utf8",
    // Progress: npm's output goes to our stderr, so stdout stays free for the caller.
    stdio: stdio === "progress" ? ["ignore", 2, 2] : ["ignore", "pipe", "pipe"],
  });
}

export interface EnsureWebResult {
  entry: string;
  /** True when this call ran `npm install`. */
  installed: boolean;
  /** Version directories removed after a successful install. */
  removed: string[];
}

/**
 * The dashboard entry for `version`, installing it under `<dataDir>/web/<version>` when missing.
 * No network when it is already there. Throws with the manual alternative when the install fails.
 */
export function ensureWeb(dataDir: string, version: string, log: (line: string) => void): EnsureWebResult {
  const target = webInstallDir(dataDir, version);
  const present = installedWebEntry(target, version);
  if (present) return { entry: present, installed: false, removed: [] };

  const spec = process.env["DUSKFLEET_WEB_SPEC"] || `${WEB_PACKAGE}@${version}`;
  // Per process: two concurrent first starts of one version must not delete each other's install.
  const staging = `${target}.${process.pid}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  log(`installing ${spec} into ${target} (first start of this version)...`);
  const started = Date.now();
  const r = runNpm(["install", "--prefix", staging, "--no-audit", "--no-fund", spec], "progress");
  const entry = r.status === 0 ? installedWebEntry(staging, version) : null;
  if (!entry) {
    rmSync(staging, { recursive: true, force: true });
    const why = r.error
      ? `npm could not be started (${r.error.message})`
      : r.status !== 0
        ? `npm install exited with ${r.status ?? r.signal} (offline, or the registry is unreachable?)`
        : `the installed package is not ${WEB_PACKAGE}@${version}`;
    throw new Error(`could not install the dashboard: ${why}; ${manualInstallHint(version)}`);
  }
  const finalEntry = promoteStaging(staging, target, version);
  log(`installed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  const base = path.dirname(target);
  const dirs = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const removed: string[] = [];
  for (const name of olderWebVersions(dirs, version)) {
    try {
      rmSync(path.join(base, name), { recursive: true, force: true });
      removed.push(name);
    } catch (err) {
      log(`could not remove the older dashboard install ${name}: ${(err as Error).message}`);
    }
  }
  if (removed.length) log(`removed older dashboard install(s): ${removed.join(", ")}`);
  return { entry: finalEntry, installed: true, removed };
}

/**
 * Moves a verified staging install to `target` and returns the entry there. When another run
 * finished first (`target` already holds `version`, before the replace or by winning the rename),
 * its install is reused and the staging directory dropped; only a broken leftover is replaced.
 */
export function promoteStaging(staging: string, target: string, version: string): string {
  const reuse = () => {
    const existing = installedWebEntry(target, version);
    if (existing) rmSync(staging, { recursive: true, force: true });
    return existing;
  };
  const before = reuse();
  if (before) return before;
  rmSync(target, { recursive: true, force: true });
  try {
    renameSync(staging, target);
  } catch (err) {
    const after = reuse();
    if (after) return after;
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  const entry = installedWebEntry(target, version);
  if (!entry) throw new Error(`the installed package is not ${WEB_PACKAGE}@${version}; ${manualInstallHint(version)}`);
  return entry;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Semver precedence of two versions (build metadata not supported): <0, 0 or >0. */
export function compareVersions(a: string, b: string): number {
  const ma = SEMVER.exec(a);
  const mb = SEMVER.exec(b);
  if (!ma || !mb) throw new Error(`not a semver version: ${ma ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d;
  }
  const pa = ma[4];
  const pb = mb[4];
  if (pa === undefined || pb === undefined) return pa === pb ? 0 : pa === undefined ? 1 : -1;
  const ia = pa.split(".");
  const ib = pb.split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The directories under `<dataDir>/web` that may be removed once `version` is installed: finished
 * installs of an older semver version only. A newer version (a downgrade or a pinned older CLI,
 * possibly running), a `.partial` staging directory (a concurrent install) and anything that is
 * not a version stay.
 */
export function olderWebVersions(dirNames: string[], version: string): string[] {
  if (!SEMVER.test(version)) return [];
  return dirNames.filter(
    (name) => !name.endsWith(".partial") && SEMVER.test(name) && compareVersions(name, version) < 0,
  );
}

/**
 * `--no-install`: the data directory install when it is there, else a global
 * `npm install -g @duskfleet/web@<version>`. Never installs; throws when neither matches.
 */
export function findWeb(dataDir: string, version: string): string {
  const local = installedWebEntry(webInstallDir(dataDir, version), version);
  if (local) return local;
  const root = runNpm(["root", "-g"], "pipe");
  const globalRoot = root.status === 0 ? String(root.stdout).trim() : "";
  if (globalRoot) {
    const pkgDir = path.join(globalRoot, ...WEB_PACKAGE.split("/"));
    const found = packageDirVersion(pkgDir);
    if (found === version) return path.join(pkgDir, "bin", "start.mjs");
    if (found) {
      throw new Error(
        `the global ${WEB_PACKAGE} is ${found}, this CLI is ${version}; ${manualInstallHint(version)}, or drop --no-install`,
      );
    }
  }
  throw new Error(`${WEB_PACKAGE}@${version} is not installed; ${manualInstallHint(version)}, or drop --no-install`);
}

/** Port flag to a number, refusing anything that is not a TCP port. */
export function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_DASHBOARD_PORT;
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < 1 || n > 65535)
    throw new Error(`--port must be a TCP port (1-65535), got "${value}"`);
  return n;
}

/** The platform opener for a URL: `open`, `xdg-open`, `start`. */
export function openerCommand(platform: NodeJS.Platform, url: string): { bin: string; args: string[] } {
  if (platform === "darwin") return { bin: "open", args: [url] };
  if (platform === "win32") return { bin: "cmd", args: ["/c", "start", "", url] };
  return { bin: "xdg-open", args: [url] };
}

function openBrowser(url: string, log: (line: string) => void): void {
  const { bin, args } = openerCommand(process.platform, url);
  const child = spawn(bin, args, { stdio: "ignore", detached: true });
  child.on("error", () => log(`could not open a browser; open ${url} yourself`));
  child.unref();
}

/**
 * Throws when something already listens on 127.0.0.1:`port` (another dashboard, `npm run web`):
 * the readiness probe would be answered by it and the browser opened on it, while our server dies
 * with EADDRINUSE. Checked both ways: a connection that succeeds, and a listen that fails.
 */
export async function assertPortFree(port: number): Promise<void> {
  const answered = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
  const listenError = answered
    ? null
    : await new Promise<NodeJS.ErrnoException | null>((resolve) => {
        const server = createServer();
        server.once("error", (err: NodeJS.ErrnoException) => resolve(err));
        server.listen(port, "127.0.0.1", () => server.close(() => resolve(null)));
      });
  if (!answered && !listenError) return;
  const why =
    answered || listenError?.code === "EADDRINUSE" ? "is already in use" : `cannot be used (${listenError?.code})`;
  throw new Error(
    `port ${port} on 127.0.0.1 ${why}: stop what listens there (another dashboard, npm run web?) or pick another port with --port <n>`,
  );
}

const exitedAlready = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/**
 * Resolves once the server answers on 127.0.0.1 (any status) and our child is still alive a moment
 * later, false when the child exits first: an answer from another process that took the port
 * after `assertPortFree` must not print the URL nor open the browser.
 */
async function waitUntilServing(child: ChildProcess, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  while (Date.now() < deadline) {
    if (exitedAlready(child)) return false;
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      await pause(300);
      return !exitedAlready(child);
    } catch {
      await pause(300);
    }
  }
  return false;
}

export interface StartDashboardOptions {
  entry: string;
  port: number;
  configDir: string;
  open: boolean;
  log: (line: string) => void;
}

/**
 * Runs the dashboard in the foreground: bound to 127.0.0.1 by bin/start.mjs, the config of this
 * CLI through DUSKFLEET_CONFIG, no telemetry. Ctrl-C stops it. Resolves with its exit code, 0
 * when it exits after a SIGINT / SIGTERM forwarded by this process (a normal stop). Throws before
 * spawning when the port is taken.
 */
export async function startDashboard(options: StartDashboardOptions): Promise<number> {
  const { entry, port, configDir, log } = options;
  await assertPortFree(port);
  const child = spawn(process.execPath, [entry], {
    stdio: "inherit",
    env: {
      ...process.env,
      DUSKFLEET_CONFIG: configDir,
      PORT: String(port),
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });
  let stopRequested = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stopRequested = true;
      child.kill(signal);
    });
  }
  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code, signal) => resolve(stopRequested ? 0 : (code ?? (signal ? 1 : 0))));
    child.on("error", (err) => {
      log(`could not start the dashboard: ${err.message}`);
      resolve(1);
    });
  });
  const url = `http://localhost:${port}`;
  void waitUntilServing(child, port, 120_000).then((up) => {
    if (!up) return;
    log(`dashboard: ${url} (Ctrl-C to stop)`);
    if (options.open) openBrowser(url, log);
  });
  return exited;
}
