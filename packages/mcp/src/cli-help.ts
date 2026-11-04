/**
 * Per-command help of the CLI: `duskfleet <command> --help` (or `-h`) prints one block (usage,
 * options, an example, the doc link) on stdout with exit 0, before any config is loaded. A wrong
 * invocation names what is wrong and prints the same block on stderr with exit 2.
 */

const DOCS = "https://github.com/duskfleet/duskfleet/blob/main/docs";

interface CommandHelp {
  usage: string[];
  /** One line per option: `--flag <value>   what it does`. */
  options?: string[];
  example: string;
  doc: string;
}

export const COMMAND_HELP: Readonly<Record<string, CommandHelp>> = {
  init: {
    usage: ["duskfleet init [--yes] [--mcp claude-code|claude-desktop]"],
    options: [
      "-y, --yes        ask nothing (scripts, CI)",
      "--mcp <target>   register the MCP server in claude-code or claude-desktop",
    ],
    example: "duskfleet init",
    doc: `${DOCS}/cli.md#init`,
  },
  agents: {
    usage: [
      "duskfleet agents",
      "duskfleet agents create <id> [--model <m>] [--budget <usd>] [--permission-mode <mode>]",
      "                       [--allowed-tools <a,b>] [--disallowed-tools <a,b>] [--timeout <minutes>]",
      '                       [--description <text>] [--force] (-- "<system prompt>" | --prompt-file <file>)',
    ],
    options: [
      "-m, --model <m>             model of the agent (none: the Claude Code default)",
      "--budget <usd>              max_budget_usd per run (default 0.5)",
      "--permission-mode <mode>    default dontAsk",
      "--allowed-tools <a,b>       default: file tools and the common test runners",
      "--disallowed-tools <a,b>",
      "--timeout <minutes>         default 10",
      "--description <text>",
      "--prompt-file <file>        the system prompt from a file, instead of the text after --",
      "--force                     overwrite an agent with the same id",
    ],
    example: 'duskfleet agents create fixer --model haiku -- "You fix the failing test in this project."',
    doc: `${DOCS}/cli.md#agents-create`,
  },
  projects: {
    usage: ["duskfleet projects"],
    example: "duskfleet projects",
    doc: `${DOCS}/configuration.md`,
  },
  run: {
    usage: ['duskfleet run --project <id or path> [--agent <id>] [--model <m>] [--no-wait] -- "<prompt>"'],
    options: [
      "-p, --project <id or path>   registered project id or absolute path",
      "--project-id <id>            the explicit form of a registered id",
      "-a, --agent <id>             the agent to run (default: default_agent)",
      "-m, --model <m>              override the agent's model",
      "--no-wait                    print the run id and exit (the run is not recorded once the CLI exits)",
    ],
    example: 'duskfleet run --project my-app --agent fixer --model haiku -- "Fix the failing test"',
    doc: `${DOCS}/cli.md#first-run`,
  },
  runs: {
    usage: ["duskfleet runs [--status <status>] [--limit <n>] [--agent <id>]"],
    options: [
      "--status <status>   pending, running, completed, failed, cancelled or timed_out",
      "--limit <n>         at most n runs",
      "--agent <id>        runs of one agent",
    ],
    example: "duskfleet runs --status completed --limit 10",
    doc: `${DOCS}/cli.md#what-a-run-records`,
  },
  "run-info": {
    usage: ["duskfleet run-info <run_id> [--events]"],
    options: ["--events   add the event timeline"],
    example: "duskfleet run-info <run_id> --events",
    doc: `${DOCS}/cli.md#what-a-run-records`,
  },
  "repair-subagents": {
    usage: ["duskfleet repair-subagents"],
    example: "duskfleet repair-subagents",
    doc: `${DOCS}/cli.md`,
  },
  schedules: {
    usage: ["duskfleet schedules", "duskfleet schedules run-now <schedule id or name>"],
    example: 'duskfleet schedules run-now "pr review"',
    doc: `${DOCS}/schedules.md`,
  },
  budgets: {
    usage: [
      "duskfleet budgets",
      "duskfleet budgets set <global | agent <id> | project <id>> --amount <usd> [--warn <percent>] [--no-hard-stop] [--unpriced count|allow]",
      "duskfleet budgets delete <budget id>",
    ],
    options: [
      "--amount <usd>       monthly amount (UTC month)",
      "--warn <percent>     warn at this share of the amount",
      "--no-hard-stop       warn only, never pause the scope's schedules",
      "--unpriced <policy>  count (default): runs of unknown cost count at a stand-in; allow: ignore them",
    ],
    example: "duskfleet budgets set project my-app --amount 50 --warn 80",
    doc: `${DOCS}/schedules.md`,
  },
  tools: {
    usage: ["duskfleet tools"],
    example: "duskfleet tools",
    doc: `${DOCS}/mcp-server.md`,
  },
  dashboard: {
    usage: ["duskfleet dashboard [--port 4777] [--no-open] [--no-install]"],
    options: [
      "--port <n>      port of the dashboard (default 4777)",
      "--no-open       do not open the browser",
      "--no-install    use an installed @duskfleet/web, never install it",
    ],
    example: "duskfleet dashboard --port 4777",
    doc: `${DOCS}/dashboard.md`,
  },
  serve: {
    usage: ["duskfleet serve"],
    example: "duskfleet serve",
    doc: `${DOCS}/schedules.md#who-ticks`,
  },
  "install-service": {
    usage: ["duskfleet install-service [--print] [--keep-awake | --no-keep-awake]"],
    options: [
      "--print           print the unit and its install commands, change nothing",
      "--keep-awake      macOS: run serve under caffeinate -i -s, no sleep while on AC (default)",
      "--no-keep-awake   macOS: render the unit without caffeinate; the Mac may sleep",
    ],
    example: "duskfleet install-service --print",
    doc: `${DOCS}/schedules.md#who-ticks`,
  },
  "uninstall-service": {
    usage: ["duskfleet uninstall-service"],
    example: "duskfleet uninstall-service",
    doc: `${DOCS}/schedules.md#who-ticks`,
  },
  mcp: {
    usage: ["duskfleet mcp register --target claude-code|claude-desktop [--dry-run] [--yes]", "duskfleet mcp status"],
    options: [
      "--target <host>   claude-code or claude-desktop",
      "--dry-run         show the change, write nothing",
      "--yes             apply without asking",
    ],
    example: "duskfleet mcp register --target claude-desktop --dry-run",
    doc: `${DOCS}/mcp-server.md`,
  },
  doctor: {
    usage: ["duskfleet doctor [--probe]"],
    options: ["--probe   plus one real hello run on haiku (costs cents)"],
    example: "duskfleet doctor --probe",
    doc: `${DOCS}/cli.md#doctor-logs-and-diffs`,
  },
};

export function isCommand(name: string): boolean {
  return Object.hasOwn(COMMAND_HELP, name);
}

/** `--help` or `-h` among the arguments, before any `--` (what follows `--` is a prompt). */
export function wantsHelp(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

/** The help block of one command, ending with a newline. */
export function commandHelp(name: string): string {
  const help = COMMAND_HELP[name];
  if (!help) throw new Error(`no help for command: ${name}`);
  const lines = ["Usage:", ...help.usage.map((u) => `  ${u}`)];
  if (help.options?.length) lines.push("", "Options:", ...help.options.map((o) => `  ${o}`));
  lines.push("", "Example:", `  ${help.example}`, "", `Docs: ${help.doc}`, "");
  return lines.join("\n");
}

/** `unknown command: <name>` and the commands there are, ending with a newline. */
export function unknownCommandText(name: string): string {
  return `unknown command: ${name}\ncommands: ${Object.keys(COMMAND_HELP).join(", ")}\nRun "duskfleet --help" for the usage.\n`;
}
