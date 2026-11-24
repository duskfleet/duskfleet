#!/usr/bin/env node
/**
 * Stand-in for GitHub Copilot CLI (issue #446): replays the real runs in fixtures/copilot/ so the
 * tests never launch the real CLI. The prompt (read from stdin, as the adapter sends it) picks the
 * fixture: a first line `fixture:<name>` (default `edit`).
 *
 * - The fixture's session id is replaced by the one of `--session-id` / `--resume=<id>`.
 * - `--usage-output-file <f>` gets `<name>.usage.json` when the fixture has one.
 * - `resume-unknown` prints its stderr and exits 1 with nothing on stdout; `resume-unknown-noisy`
 *   does the same between two long runs of warnings.
 * - `killed` stops before its cancellation lines and prints them on SIGTERM, exit 143.
 * - `mcp list --json` prints a listing (`FAKE_COPILOT_MCP_LIST*`); the init line reports the
 *   `--disable-mcp-server` names disabled and `FAKE_COPILOT_MCP_LOADED` ones loaded (see below).
 * - `mcp add` / `mcp remove` edit the user servers of `FAKE_COPILOT_MCP_STATE` (issue #477).
 * - `FAKE_COPILOT_RECORD=<file>` (passed through by the test config) receives the argv, the
 *   environment's names, the prompt and the persona agent file `--add-dir` points at (or, for a
 *   link, the project's `.github/agents/<name>.agent.md`).
 * - `--agent <name>` without `--add-dir` (a link, #466) exits 1 like `link-unknown` when the
 *   working directory's `.github/agents/` has no `<name>.agent.md`.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "copilot");
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv[0] === "--version") {
  process.stdout.write("GitHub Copilot CLI 1.0.112.\n");
  process.exit(0);
}

// `copilot mcp list --json` (issue #476): the shape seen on 1.0.112, built-in servers only unless
// FAKE_COPILOT_MCP_LIST holds the stdout to print (verbatim, broken JSON included);
// FAKE_COPILOT_MCP_LIST_EXIT=<n> fails it instead. The trust warning always goes to stderr, as
// the real CLI prints it in an untrusted folder, unless FAKE_COPILOT_MCP_LIST_QUIET=1 (then a
// failure has an empty stderr). FAKE_COPILOT_MCP_WORKSPACE (JSON `{ <name>: {...} }`) adds
// workspace servers, listed with `source: "workspace"` before the user ones.
if (argv[0] === "mcp" && argv[1] === "list" && argv[2] === "--json") {
  const quiet = process.env.FAKE_COPILOT_MCP_LIST_QUIET === "1";
  if (!quiet) process.stderr.write("Warning: workspace MCP servers were skipped because this folder is not trusted.\n");
  const exit = Number(process.env.FAKE_COPILOT_MCP_LIST_EXIT ?? 0);
  if (exit) {
    if (!quiet) process.stderr.write("Error: could not read the MCP configuration\n");
    process.exit(exit);
  }
  const workspace = JSON.parse(process.env.FAKE_COPILOT_MCP_WORKSPACE ?? "{}");
  const listing = {
    mcpServers: {
      "github-mcp-server": { type: "http", source: "builtin", enabled: true },
      githubiq: { type: "http", source: "builtin", enabled: true },
      ...Object.fromEntries(
        Object.entries(workspace).map(([name, s]) => [name, { ...s, source: "workspace", enabled: true }]),
      ),
      ...userServers(),
    },
  };
  process.stdout.write(process.env.FAKE_COPILOT_MCP_LIST ?? `${JSON.stringify(listing, null, 2)}\n`);
  process.exit(0);
}

/**
 * `copilot mcp add <name> [--env K=V]... -- <command> [args...]` and `copilot mcp remove <name>`
 * (issue #477, forms checked by hand on 1.0.114). The user configuration lives in the JSON file
 * FAKE_COPILOT_MCP_STATE (`{ "mcpServers": { ... } }`, the shape of ~/.copilot/mcp-config.json),
 * never in the real one; `mcp list --json` lists its servers with `source: "user"`. Whether the
 * real listing carries `env` is unverified: this one does.
 */
function userServers() {
  const file = process.env.FAKE_COPILOT_MCP_STATE;
  if (!file || !existsSync(file)) return {};
  const servers = JSON.parse(readFileSync(file, "utf8")).mcpServers ?? {};
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]) => [name, { ...s, source: "user", enabled: true }]),
  );
}

function saveUserServers(servers) {
  const file = process.env.FAKE_COPILOT_MCP_STATE;
  if (!file) {
    process.stderr.write("fake-copilot: FAKE_COPILOT_MCP_STATE is not set\n");
    process.exit(2);
  }
  writeFileSync(file, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
}

if (argv[0] === "mcp" && (argv[1] === "add" || argv[1] === "remove")) {
  const file = process.env.FAKE_COPILOT_MCP_STATE;
  const servers = file && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).mcpServers ?? {}) : {};
  const end = argv.indexOf("--");
  const head = end === -1 ? argv.slice(2) : argv.slice(2, end);
  const env = {};
  const names = [];
  for (let i = 0; i < head.length; i++) {
    if (head[i] === "--env") {
      const [k, ...v] = head[++i].split("=");
      env[k] = v.join("=");
    } else names.push(head[i]);
  }
  const [name] = names;
  if (argv[1] === "remove") {
    if (!servers[name]) {
      process.stderr.write(`Error: MCP server "${name}" not found in the user configuration\n`);
      process.exit(1);
    }
    delete servers[name];
    saveUserServers(servers);
    process.stdout.write(`Removed MCP server "${name}"\n`);
    process.exit(0);
  }
  if (servers[name]) {
    process.stderr.write(`Error: MCP server "${name}" already exists\n`);
    process.exit(1);
  }
  const [command, ...args] = argv.slice(end + 1);
  servers[name] = { type: "stdio", command, args, env, tools: ["*"] };
  saveUserServers(servers);
  process.stdout.write(`Added MCP server "${name}"\n`);
  process.exit(0);
}

/**
 * The init line, as the CLI would report it: every `--disable-mcp-server` name `disabled`, and
 * the names in FAKE_COPILOT_MCP_LOADED (comma-separated) loaded despite that. Left verbatim when
 * neither applies, so the fixtures replay unchanged.
 */
function mcpInit(line) {
  const loaded = (process.env.FAKE_COPILOT_MCP_LOADED ?? "").split(",").filter(Boolean);
  const disabled = argv.flatMap((a, i) => (a === "--disable-mcp-server" ? [argv[i + 1]] : []));
  if (!loaded.length && !disabled.length) return line;
  const event = JSON.parse(line);
  const builtin = event.data.servers.filter((s) => s.source === "builtin");
  event.data.servers = [
    ...disabled.filter((n) => !loaded.includes(n)).map((name) => ({ name, status: "disabled" })),
    ...loaded.map((name) => ({ name, status: "connected" })),
    ...builtin,
  ];
  return JSON.stringify(event);
}

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  prompt += c;
});
process.stdin.on("end", main);

function main() {
  const name = /^fixture:([\w-]+)/.exec(prompt.trim())?.[1] ?? "edit";
  const resume = argv.find((a) => a.startsWith("--resume="))?.slice("--resume=".length);
  const sessionId = flag("--session-id") ?? resume ?? "00000000-0000-4000-8000-000000000000";

  const record = process.env.FAKE_COPILOT_RECORD;
  if (record) {
    const addDir = flag("--add-dir");
    const agent = flag("--agent");
    // With --add-dir: the per-run persona; without: the project's own agent file (a link).
    const personaFile = agent ? path.join(addDir ?? process.cwd(), ".github", "agents", `${agent}.agent.md`) : null;
    writeFileSync(
      record,
      JSON.stringify({
        argv,
        env: Object.keys(process.env).sort(),
        prompt,
        persona: personaFile && existsSync(personaFile) ? readFileSync(personaFile, "utf8") : null,
      }),
    );
  }

  // A project agent (`--agent <name>` without `--add-dir`, issue #466): the real CLI loads
  // <cwd>/.github/agents/<name>.agent.md; an unknown name exits 1 before any model call with
  // nothing on stdout and the names on stderr (fixture link-unknown.stderr, 1.0.114).
  const linked = flag("--agent");
  if (linked && !flag("--add-dir")) {
    const dir = path.join(process.cwd(), ".github", "agents");
    const names = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith(".agent.md"))
          .map((f) => f.slice(0, -".agent.md".length))
          .sort()
      : [];
    if (!names.includes(linked)) {
      process.stderr.write(`No such agent: ${linked}, available: ${names.join(", ")}\n`);
      process.exit(1);
    }
  }

  if (name === "resume-unknown") {
    process.stderr.write(readFileSync(path.join(fixtures, "resume-unknown.stderr"), "utf8"));
    process.exit(1);
  }
  if (name === "resume-unknown-noisy") {
    // The same error between two runs of warnings, each longer than the executor's 4000-character tail.
    const warnings = "Warning: something noisy happened\n".repeat(150);
    process.stderr.write(warnings, () => {
      process.stderr.write(readFileSync(path.join(fixtures, "resume-unknown.stderr"), "utf8"), () => {
        process.stderr.write(warnings, () => process.exit(1));
      });
    });
    return;
  }

  const lines = readFileSync(path.join(fixtures, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean);
  const original = JSON.parse(lines.at(-1)).sessionId;
  const out = lines
    .map((l) => (original ? l.split(original).join(sessionId) : l))
    .map((l) => (l.includes('"type":"session.mcp_servers_loaded"') ? mcpInit(l) : l));
  const usage = path.join(fixtures, `${name}.usage.json`);
  const usageOut = flag("--usage-output-file");
  const exitCode = JSON.parse(out.at(-1)).exitCode ?? 0;
  const finish = () => {
    if (usageOut && existsSync(usage)) writeFileSync(usageOut, readFileSync(usage, "utf8"));
  };

  if (name === "killed") {
    const cut = out.findIndex((l) => l.includes('"infoType":"cancellation"'));
    // The handler first: a SIGTERM that arrives as soon as the first line is read must find it.
    process.on("SIGTERM", () => {
      process.stdout.write(`${out.slice(cut).join("\n")}\n`, () => {
        finish();
        process.exit(143);
      });
    });
    setInterval(() => {}, 1000); // wait for the signal
    process.stdout.write(`${out.slice(0, cut).join("\n")}\n`);
    return;
  }

  process.stdout.write(`${out.join("\n")}\n`, () => {
    finish();
    process.exit(exitCode);
  });
}
