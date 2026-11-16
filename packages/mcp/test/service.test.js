/**
 * install-service: the units rendered for launchd, systemd --user and Task
 * Scheduler carry the right paths, the install / uninstall flows call the
 * service manager in the right order (through a fake exec, nothing is
 * registered on the test machine), and the lease holder encodes the role.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { formatHolder, parseHolder } from "@duskfleet/core";
import {
  exportedDataDir,
  installService,
  keepAwakeStatus,
  renderService,
  serveSleepWarning,
  serviceDirs,
  serviceStatus,
  uninstallService,
} from "../dist/service.js";

const base = {
  repoRoot: "/opt/dusk fleet",
  nodeBin: "/opt/node/bin/node",
  cliEntry: "/opt/dusk fleet/packages/mcp/dist/cli.js",
  logPath: "/opt/dusk fleet/data/logs/serve.log",
  claudeBin: "/home/me/.local/bin/claude",
  home: "/home/me",
};

function fakeExec(responses = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = `${cmd} ${args.join(" ")}`;
    for (const [pattern, r] of Object.entries(responses)) if (key.includes(pattern)) return r;
    return { status: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

test("launchd plist: node, cli, serve, cwd, log, PATH and CLAUDE_BIN; xml-escaped", () => {
  const u = renderService({ ...base, platform: "darwin", repoRoot: "/opt/a&b", cliEntry: "/opt/a&b/cli.js" });
  assert.equal(u.platform, "darwin");
  assert.equal(u.unitPath, "/home/me/Library/LaunchAgents/com.duskfleet.scheduler.plist");
  assert.match(u.content, /<key>Label<\/key><string>com\.duskfleet\.scheduler<\/string>/);
  assert.match(
    u.content,
    /<string>\/opt\/node\/bin\/node<\/string>\s*<string>\/opt\/a&amp;b\/cli\.js<\/string>\s*<string>serve<\/string>/,
  );
  assert.match(u.content, /<key>WorkingDirectory<\/key><string>\/opt\/a&amp;b<\/string>/);
  assert.match(u.content, /<key>KeepAlive<\/key><true\/>/);
  assert.match(u.content, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(u.content, /<key>PATH<\/key><string>\/opt\/node\/bin:\/home\/me\/\.local\/bin:/);
  assert.match(u.content, /<key>CLAUDE_BIN<\/key><string>\/home\/me\/\.local\/bin\/claude<\/string>/);
  assert.match(u.content, /<key>StandardErrorPath<\/key><string>\/opt\/dusk fleet\/data\/logs\/serve\.log<\/string>/);
  assert.ok(u.installCommands.some((c) => c.includes("launchctl bootstrap gui/")));
});

test("launchd plist keeps the Mac awake by default: caffeinate -i -s in front of node", () => {
  const u = renderService({ ...base, platform: "darwin" });
  assert.equal(u.keepAwake, true);
  assert.match(
    u.content,
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/usr\/bin\/caffeinate<\/string>\s*<string>-i<\/string>\s*<string>-s<\/string>\s*<string>\/opt\/node\/bin\/node<\/string>\s*<string>\/opt\/dusk fleet\/packages\/mcp\/dist\/cli\.js<\/string>\s*<string>serve<\/string>\s*<\/array>/,
  );
  assert.match(u.content, /<key>KeepAlive<\/key><true\/>/);
  assert.ok(u.notes.some((n) => /caffeinate -i -s/.test(n) && /AC power/.test(n) && /battery/.test(n)));
  // explicit true renders the same unit
  assert.equal(renderService({ ...base, platform: "darwin", keepAwake: true }).content, u.content);
});

test("--no-keep-awake renders the launchd unit as before keep-awake: node first, no caffeinate", () => {
  const u = renderService({ ...base, platform: "darwin", keepAwake: false });
  assert.equal(u.keepAwake, false);
  assert.doesNotMatch(u.content, /caffeinate/);
  assert.match(u.content, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/node\/bin\/node<\/string>/);
  assert.ok(u.notes.some((n) => /Keep-awake is off/.test(n)));
});

test("Linux and Windows units never wrap serve; their notes say how to disable sleep", () => {
  const lin = renderService({ ...base, platform: "linux" });
  assert.equal(lin.keepAwake, false);
  assert.doesNotMatch(lin.content, /caffeinate|systemd-inhibit/);
  assert.ok(lin.notes.some((n) => n.includes("systemctl mask sleep.target suspend.target")));
  const win = renderService({ ...base, platform: "win32", user: "PC\\me" });
  assert.equal(win.keepAwake, false);
  assert.ok(win.notes.some((n) => n.includes("powercfg /change standby-timeout-ac 0")));
});

const PMSET = [
  "System-wide power settings:",
  "Currently in use:",
  " standby              1",
  " Sleep On Power Button 1",
  " disksleep            10",
  " sleep                1 (sleep prevented by caffeinate)",
  " displaysleep         10",
].join("\n");

test("doctor keep-awake: the loaded job's program, pmset sleep values, advice", () => {
  const home = mkdtempSync(path.join(tmpdir(), "duskfleet-awake-"));
  try {
    const wrapped = fakeExec({
      "launchctl print": { status: 0, stdout: "\tstate = running\n\tprogram = /usr/bin/caffeinate\n", stderr: "" },
      "pmset -g": { status: 0, stdout: PMSET, stderr: "" },
    });
    const a = keepAwakeStatus(wrapped.exec, home);
    assert.deepEqual([a.wrapsCaffeinate, a.sleepMinutes, a.diskSleepMinutes], [true, 1, 10]);
    assert.match(a.advice, /AC power only.*battery.*1 min/);

    const never = keepAwakeStatus(
      fakeExec({
        "launchctl print": { status: 0, stdout: "\tprogram = /usr/bin/caffeinate\n", stderr: "" },
        "pmset -g": { status: 0, stdout: " sleep                0\n disksleep            0\n", stderr: "" },
      }).exec,
      home,
    );
    assert.deepEqual([never.wrapsCaffeinate, never.sleepMinutes, never.advice], [true, 0, null]);

    const bare = keepAwakeStatus(
      fakeExec({
        "launchctl print": { status: 0, stdout: "\tprogram = /opt/node/bin/node\n", stderr: "" },
        "pmset -g": { status: 0, stdout: PMSET, stderr: "" },
      }).exec,
      home,
    );
    assert.equal(bare.wrapsCaffeinate, false);
    assert.match(bare.advice, /does not keep the Mac awake.*install-service/);

    // not loaded, no plist: nothing to tell; pmset unreadable: null values
    const none = keepAwakeStatus(
      fakeExec({
        "launchctl print": { status: 113, stdout: "", stderr: "Could not find service" },
        "pmset -g": { status: null, stdout: "", stderr: "ENOENT" },
      }).exec,
      home,
    );
    assert.deepEqual(
      [none.wrapsCaffeinate, none.sleepMinutes, none.diskSleepMinutes, none.advice],
      [null, null, null, null],
    );

    // not loaded but the plist is on disk: read from the file
    const unloaded = fakeExec({ "launchctl print": { status: 113, stdout: "", stderr: "" } });
    installService({ ...base, platform: "darwin", home, logPath: path.join(home, "serve.log") }, fakeExec().exec);
    assert.equal(keepAwakeStatus(unloaded.exec, home).wrapsCaffeinate, true);
    installService(
      { ...base, platform: "darwin", home, logPath: path.join(home, "serve.log"), keepAwake: false },
      fakeExec().exec,
    );
    assert.equal(keepAwakeStatus(unloaded.exec, home).wrapsCaffeinate, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("serve warns once on macOS when its parent is not caffeinate", () => {
  const parent = (comm) => fakeExec({ "ps -o comm=": { status: 0, stdout: `${comm}\n`, stderr: "" } });
  assert.equal(serveSleepWarning("darwin", 42, parent("/usr/bin/caffeinate").exec), null);
  const shell = parent("-zsh");
  assert.match(serveSleepWarning("darwin", 42, shell.exec), /may sleep.*install-service --keep-awake/);
  assert.deepEqual(shell.calls[0], ["ps", "-o", "comm=", "-p", "42"]);
  assert.match(serveSleepWarning("darwin", 1, parent("/sbin/launchd").exec), /caffeinate/);
  // other platforms: no check, no warning
  const lin = fakeExec();
  assert.equal(serveSleepWarning("linux", 42, lin.exec), null);
  assert.equal(lin.calls.length, 0);
});

test("systemd user unit: quoted ExecStart, Restart=always, log append, no CLAUDE_BIN when unknown", () => {
  const u = renderService({ ...base, platform: "linux", claudeBin: null });
  assert.equal(u.unitPath, "/home/me/.config/systemd/user/duskfleet.service");
  assert.match(
    u.content,
    /^ExecStart="\/opt\/node\/bin\/node" "\/opt\/dusk fleet\/packages\/mcp\/dist\/cli\.js" serve$/m,
  );
  assert.match(u.content, /^WorkingDirectory=\/opt\/dusk fleet$/m);
  assert.match(u.content, /^Restart=always$/m);
  assert.match(u.content, /^StandardError=append:\/opt\/dusk fleet\/data\/logs\/serve\.log$/m);
  assert.match(u.content, /^WantedBy=default\.target$/m);
  assert.doesNotMatch(u.content, /CLAUDE_BIN/);
  assert.match(u.content, /^Environment="PATH=\/opt\/node\/bin:\/usr\/local\/bin/m);
});

test("Task Scheduler XML: logon trigger, no time limit, restart on failure, cmd wrapper appends the log", () => {
  const u = renderService({
    ...base,
    platform: "win32",
    nodeBin: "C:\\node\\node.exe",
    cliEntry: "C:\\dusk\\cli.js",
    logPath: "C:\\dusk\\data\\logs\\serve.log",
    repoRoot: "C:\\dusk",
    user: "PC\\me",
  });
  assert.equal(u.label, "Duskfleet Scheduler");
  assert.match(u.content, /<LogonTrigger>/);
  assert.match(u.content, /<UserId>PC\\me<\/UserId>/);
  assert.match(u.content, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(u.content, /<RestartOnFailure>/);
  assert.match(u.content, /<Command>cmd\.exe<\/Command>/);
  assert.match(
    u.content,
    /<Arguments>\/c &quot;&quot;C:\\node\\node\.exe&quot; &quot;C:\\dusk\\cli\.js&quot; serve &gt;&gt; &quot;C:\\dusk\\data\\logs\\serve\.log&quot; 2&gt;&amp;1&quot;<\/Arguments>/,
  );
  assert.match(u.content, /<WorkingDirectory>C:\\dusk<\/WorkingDirectory>/);
  assert.ok(u.installCommands[0].includes("schtasks /Create /F /TN"));
});

test("installed package: no repo root, the unit runs beside the config and exports DUSKFLEET_CONFIG", () => {
  // checkout with its own config/: nothing exported, the service finds it
  assert.deepEqual(serviceDirs("/opt/dusk", "/opt/dusk/config"), { repoRoot: "/opt/dusk", configDir: null });
  // checkout, config elsewhere (DUSKFLEET_CONFIG set by hand): exported
  assert.deepEqual(serviceDirs("/opt/dusk", "/srv/df/config"), { repoRoot: "/opt/dusk", configDir: "/srv/df/config" });
  // installed package (global install): never a directory above dist
  const dirs = serviceDirs(null, "/home/me/duskfleet/config");
  assert.deepEqual(dirs, { repoRoot: "/home/me/duskfleet", configDir: "/home/me/duskfleet/config" });

  const t = { ...base, ...dirs, cliEntry: "/usr/local/lib/node_modules/duskfleet/dist/cli.js" };
  const mac = renderService({ ...t, platform: "darwin" });
  assert.match(mac.content, /<key>WorkingDirectory<\/key><string>\/home\/me\/duskfleet<\/string>/);
  assert.match(mac.content, /<key>DUSKFLEET_CONFIG<\/key><string>\/home\/me\/duskfleet\/config<\/string>/);
  const lin = renderService({ ...t, platform: "linux" });
  assert.match(lin.content, /^Environment="DUSKFLEET_CONFIG=\/home\/me\/duskfleet\/config"$/m);
  const win = renderService({ ...t, platform: "win32", configDir: "C:\\df\\config", user: "PC\\me" });
  assert.match(win.content, /<Arguments>\/c &quot;set &quot;DUSKFLEET_CONFIG=C:\\df\\config&quot;&amp;&amp; &quot;/);
  // a checkout unit stays as it was
  assert.doesNotMatch(renderService({ ...base, platform: "linux" }).content, /DUSKFLEET_CONFIG/);
});

test("DUSKFLEET_DATA set at install time is carried by the unit, so the service opens the same database", () => {
  const t = { ...base, dataDir: "/srv/df/data", logPath: "/srv/df/data/logs/serve.log" };
  const mac = renderService({ ...t, platform: "darwin" });
  assert.match(mac.content, /<key>DUSKFLEET_DATA<\/key><string>\/srv\/df\/data<\/string>/);
  const lin = renderService({ ...t, platform: "linux" });
  assert.match(lin.content, /^Environment="DUSKFLEET_DATA=\/srv\/df\/data"$/m);
  const win = renderService({
    ...t,
    platform: "win32",
    configDir: "C:\\df\\config",
    dataDir: "D:\\df data",
    nodeBin: "C:\\node\\node.exe",
    user: "PC\\me",
  });
  assert.match(
    win.content,
    /<Arguments>\/c &quot;set &quot;DUSKFLEET_CONFIG=C:\\df\\config&quot;&amp;&amp; set &quot;DUSKFLEET_DATA=D:\\df data&quot;&amp;&amp; &quot;C:\\node\\node\.exe&quot;/,
  );
  // not set (data_dir or the default): the service resolves it itself, nothing exported
  for (const platform of ["darwin", "linux", "win32"]) {
    assert.doesNotMatch(renderService({ ...base, platform, user: "PC\\me" }).content, /DUSKFLEET_DATA/);
  }
});

test("exportedDataDir: DUSKFLEET_DATA and an XDG data dir are exported, the derivable default is not", () => {
  const ctx = { platform: "linux", home: "/home/me", env: {} };
  const userConfig = "/home/me/.config/duskfleet";
  // DUSKFLEET_DATA: always
  assert.equal(exportedDataDir("/srv/df/data", "env", "/srv/df/config", ctx), "/srv/df/data");
  // data_dir or ../data in duskfleet.yaml: follows the config, nothing to export
  assert.equal(exportedDataDir("/srv/df/data", "config", "/srv/df/config", ctx), null);
  // user-level default without XDG: the unit derives the same directory
  assert.equal(exportedDataDir("/home/me/.local/share/duskfleet", "user", userConfig, ctx), null);
  // XDG_DATA_HOME in this shell only: the unit would fall back to ~/.local/share
  const xdg = { ...ctx, env: { XDG_DATA_HOME: "/xdg/data" } };
  assert.equal(exportedDataDir("/xdg/data/duskfleet", "user", userConfig, xdg), "/xdg/data/duskfleet");
});

test("exportedDataDir: XDG_CONFIG_HOME alone still exports the data dir the unit would not derive", () => {
  // Shell: config /x/c/duskfleet is the user-level config, data defaults to ~/.local/share/duskfleet.
  // Unit: gets DUSKFLEET_CONFIG=/x/c/duskfleet but no XDG_CONFIG_HOME, so that config is not its
  // user-level one and it would fall back to /x/c/data: a second database without the export.
  const ctx = { platform: "linux", home: "/home/me", env: { XDG_CONFIG_HOME: "/x/c" } };
  assert.equal(
    exportedDataDir("/home/me/.local/share/duskfleet", "user", "/x/c/duskfleet", ctx),
    "/home/me/.local/share/duskfleet",
  );
  // Both XDG variables set: still exported (the unit would derive /x/c/data, not /x/d/duskfleet).
  const both = { ...ctx, env: { XDG_CONFIG_HOME: "/x/c", XDG_DATA_HOME: "/x/d" } };
  assert.equal(exportedDataDir("/x/d/duskfleet", "user", "/x/c/duskfleet", both), "/x/d/duskfleet");
});

test("a cli.js inside the npx cache is refused: the unit would break once npm evicts it", () => {
  const npx = { ...base, cliEntry: "/home/me/.npm/_npx/1a2b/node_modules/duskfleet/dist/cli.js" };
  for (const platform of ["darwin", "linux"]) {
    assert.throws(() => renderService({ ...npx, platform }), /npx's temporary cache.*npm install -g duskfleet/);
  }
  assert.throws(
    () => renderService({ ...base, platform: "win32", user: "PC\\me", cliEntry: "C:\\npm-cache\\_npx\\1\\cli.js" }),
    /temporary cache/,
  );
  // "_npx" as part of a longer name is not the cache
  assert.doesNotMatch(
    renderService({ ...base, platform: "linux", cliEntry: "/opt/my_npx_tools/cli.js" }).content,
    /_npx\/1/,
  );
});

test("Linux without a user bus: install writes nothing, a failed reload removes the unit, doctor says not installed", () => {
  const home = mkdtempSync(path.join(tmpdir(), "duskfleet-nobus-"));
  const t = { ...base, platform: "linux", home, logPath: path.join(home, "data", "logs", "serve.log") };
  const unitPath = path.join(home, ".config", "systemd", "user", "duskfleet.service");
  const noBus = { status: 1, stdout: "", stderr: "Failed to connect to user scope bus via local transport" };
  try {
    // no bus at all: refused before anything is written, with the hint
    const probe = fakeExec({ "show-environment": noBus });
    assert.throws(
      () => installService(t, probe.exec),
      (err) =>
        /no systemd user bus.*user scope bus.*nothing was written/.test(err.message) &&
        /loginctl enable-linger \$USER/.test(err.message) &&
        /terminal, tmux or your own supervisor/.test(err.message),
    );
    assert.equal(existsSync(unitPath), false);
    assert.deepEqual(
      probe.calls.map((c) => c.slice(1).join(" ")),
      ["--user show-environment"],
    );

    // systemctl missing (spawn error): same refusal
    assert.throws(
      () =>
        installService(
          t,
          fakeExec({ "show-environment": { status: null, stdout: "", stderr: "spawnSync systemctl ENOENT" } }).exec,
        ),
      /no systemd user bus \(spawnSync systemctl ENOENT\)/,
    );
    assert.equal(existsSync(unitPath), false);

    // the probe passes but daemon-reload fails: the new unit is removed again
    const reload = fakeExec({ "daemon-reload": noBus });
    assert.throws(() => installService(t, reload.exec), /daemon-reload failed.*supervisor/);
    assert.equal(existsSync(unitPath), false);
    assert.ok(!reload.calls.some((c) => c.includes("enable")));

    // ...and an earlier unit is put back as it was
    installService(t, fakeExec().exec);
    const before = readFileSync(unitPath, "utf8");
    assert.throws(() => installService({ ...t, claudeBin: null }, reload.exec), /daemon-reload failed/);
    assert.equal(readFileSync(unitPath, "utf8"), before);

    // doctor: a unit file on disk without a reachable bus is not an installed service
    const st = serviceStatus("linux", () => noBus, home);
    assert.deepEqual([st.installed, st.running], [false, null]);
    assert.match(st.detail, /^unit present, not loaded: systemd user bus unreachable \(Failed to connect/);
    assert.match(st.advice, /terminal, tmux or your own supervisor/);
    // a unit file systemd has not loaded is not installed either
    const nf = serviceStatus(
      "linux",
      () => ({
        status: 0,
        stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n",
        stderr: "",
      }),
      home,
    );
    assert.deepEqual(
      [nf.installed, nf.running, nf.detail],
      [false, false, "unit present, not loaded: run install-service"],
    );
    assert.equal(nf.advice, undefined);
    rmSync(unitPath);
    const gone = serviceStatus("linux", () => noBus, home);
    assert.match(gone.detail, /^systemd user bus unreachable/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("unsupported platform is refused with a hint", () => {
  assert.throws(() => renderService({ ...base, platform: "freebsd" }), /duskfleet serve/);
  const s = serviceStatus("freebsd", () => ({ status: 0, stdout: "", stderr: "" }), "/home/me");
  assert.equal(s.supported, false);
});

test("install writes the unit and drives the service manager; uninstall removes it", () => {
  const home = mkdtempSync(path.join(tmpdir(), "duskfleet-svc-"));
  const logDir = path.join(home, "data", "logs");
  try {
    // macOS: bootout (ignored), bootstrap; the unit lands in ~/Library/LaunchAgents
    const mac = fakeExec({
      "launchctl bootout": { status: 3, stdout: "", stderr: "Boot-out failed: 3: No such process" },
    });
    const r = installService({ ...base, platform: "darwin", home, logPath: path.join(logDir, "serve.log") }, mac.exec);
    assert.ok(existsSync(r.unit.unitPath));
    assert.ok(existsSync(logDir));
    assert.equal(mac.calls[0][1], "bootout");
    assert.equal(mac.calls[1][1], "bootstrap");
    assert.equal(mac.calls[1][3], r.unit.unitPath);

    // a failing bootstrap surfaces its stderr
    const bad = fakeExec({
      "launchctl bootstrap": { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" },
    });
    assert.throws(
      () => installService({ ...base, platform: "darwin", home, logPath: path.join(logDir, "serve.log") }, bad.exec),
      /Input\/output error/,
    );

    // status parses launchctl print
    const st = serviceStatus(
      "darwin",
      () => ({
        status: 0,
        stdout:
          "com.duskfleet.scheduler = {\n\tactive count = 1\n\tpath = x\n\tstate = running\n\n\tprogram = node\n\tpid = 4242\n}",
        stderr: "",
      }),
      home,
    );
    assert.deepEqual([st.installed, st.running, st.pid], [true, true, 4242]);
    const off = serviceStatus("darwin", () => ({ status: 113, stdout: "", stderr: "Could not find service" }), home);
    assert.deepEqual([off.installed, off.running], [true, false]);

    const un = uninstallService("darwin", mac.exec, home);
    assert.equal(un.removed, true);
    assert.ok(!existsSync(r.unit.unitPath));

    // Linux: daemon-reload, enable, restart
    const lin = fakeExec();
    const rl = installService({ ...base, platform: "linux", home, logPath: path.join(logDir, "serve.log") }, lin.exec);
    assert.equal(rl.unit.unitPath, path.join(home, ".config", "systemd", "user", "duskfleet.service"));
    assert.deepEqual(
      lin.calls.map((c) => c.slice(1).join(" ")),
      [
        "--user show-environment",
        "--user daemon-reload",
        "--user enable duskfleet.service",
        "--user restart duskfleet.service",
      ],
    );
    assert.ok(rl.unit.notes.some((n) => n.includes("loginctl enable-linger $USER")));
    const ls = serviceStatus(
      "linux",
      () => ({ status: 0, stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=77\n", stderr: "" }),
      home,
    );
    assert.deepEqual([ls.installed, ls.running, ls.pid], [true, true, 77]);
    uninstallService("linux", lin.exec, home);
    assert.ok(!existsSync(rl.unit.unitPath));

    // Windows: the XML is UTF-16LE with a BOM, then /Create and /Run
    const win = fakeExec();
    const rw = installService(
      { ...base, platform: "win32", home, logPath: path.join(logDir, "serve.log"), user: "PC\\me" },
      win.exec,
    );
    const bytes = readFileSync(rw.unit.unitPath);
    assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xfe]);
    assert.match(bytes.subarray(2).toString("utf16le"), /<Task version="1.4"/);
    assert.deepEqual(
      win.calls.map((c) => c[1]),
      ["/End", "/Create", "/Run"],
    );
    const ws = serviceStatus(
      "win32",
      () => ({
        status: 0,
        stdout: "HostName: PC\r\nTaskName: \\Duskfleet Scheduler\r\nStatus: Running\r\n",
        stderr: "",
      }),
      home,
    );
    assert.deepEqual([ws.installed, ws.running], [true, true]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("lease holder carries the process role", () => {
  assert.equal(formatHolder("serve", "mac", 12), "serve@mac:12");
  assert.deepEqual(parseHolder("serve@mac:12"), { role: "serve", host: "mac", pid: 12 });
  assert.deepEqual(parseHolder("mcp@my-host.local:3"), { role: "mcp", host: "my-host.local", pid: 3 });
  // rows written before roles existed
  assert.deepEqual(parseHolder("my-host:99"), { role: "unknown", host: "my-host", pid: 99 });
  assert.deepEqual(parseHolder("A"), { role: "unknown", host: "A", pid: null });
});
