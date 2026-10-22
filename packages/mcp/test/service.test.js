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
import { installService, renderService, serviceStatus, uninstallService } from "../dist/service.js";

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
      ["--user daemon-reload", "--user enable duskfleet.service", "--user restart duskfleet.service"],
    );
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
