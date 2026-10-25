import Link from "next/link";
import { CopyButton } from "@/components/CopyButton";
import { TocSpy } from "@/components/TocSpy";
import { type JsonSchema, mcpRegistration, type ToolCatalogEntry, toolCatalog } from "@/lib/data";
import { fmtRelative, fmtTime } from "@/lib/format";
import { filterTools } from "@/lib/tools";

export const dynamic = "force-dynamic";

export const metadata = { title: "MCP tools · Duskfleet" };

const GROUPS: Array<{ key: ToolCatalogEntry["group"]; title: string; blurb: string }> = [
  { key: "runs", title: "Runs", blurb: "Start, watch and stop agent executions." },
  { key: "agents", title: "Agents", blurb: "Discover and manage agent definitions (Markdown files in data/agents)." },
  { key: "schedules", title: "Schedules", blurb: "Cron schedules that fire agents unattended." },
  { key: "projects", title: "Projects", blurb: "Registered project directories." },
  { key: "other", title: "Other", blurb: "" },
];

export default async function McpPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = (await searchParams).q?.trim() || undefined;
  const catalog = toolCatalog();
  const reg = mcpRegistration();
  const desktopJson = JSON.stringify(
    { mcpServers: { duskfleet: { command: reg.node, args: [reg.entry], env: { CLAUDE_BIN: reg.claudeBin } } } },
    null,
    2,
  );
  const claudeCodeCmd = `claude mcp add --scope user duskfleet -e CLAUDE_BIN=${reg.claudeBin} -- ${reg.node} ${reg.entry}`;
  const tools = catalog ? filterTools(catalog.tools, q) : [];
  const groups = GROUPS.filter((g) => tools.some((t) => t.group === g.key));

  return (
    <>
      <div className="page-head">
        <h1>
          MCP{" "}
          {catalog ? (
            <span className="count">
              {q ? `${tools.length} of ${catalog.tools.length}` : catalog.tools.length} tools
            </span>
          ) : (
            "tools"
          )}
        </h1>
        {catalog && (
          <span className="note">
            server <code>{catalog.server.name}</code> v{catalog.server.version} ·{" "}
            <span
              title={`Written by npm run build to packages/mcp/dist/tools.json on ${fmtTime(catalog.generatedAt)}. Hosts load the server once: after a rebuild, restart Claude Desktop / Claude Code to get the new tools.`}
            >
              catalogue built {fmtRelative(catalog.generatedAt)} (restart the host after a rebuild)
            </span>
          </span>
        )}
      </div>

      {!catalog ? (
        <div className="callout warn">
          <span className="icon">!</span>
          <div>
            <strong>No catalogue found.</strong> It is written by <code>npm run build</code> of{" "}
            <code>@duskfleet/mcp</code> to
            <code> packages/mcp/dist/tools.json</code>. Run the build and reload.
          </div>
        </div>
      ) : (
        <>
          <div className="toolbar">
            <div className="toolbar-row">
              {/* biome-ignore lint/a11y/useSemanticElements: the <search> element is not styled here; role="search" on the form is the established pattern */}
              <form className="search" action="/mcp" method="get" role="search">
                <input
                  type="search"
                  name="q"
                  defaultValue={q ?? ""}
                  placeholder="Filter by tool or parameter name…"
                  aria-label="Filter tools"
                />
                <button type="submit" className="search-btn">
                  Filter
                </button>
                {q && (
                  <Link href="/mcp" className="clear">
                    × clear filter
                  </Link>
                )}
              </form>
            </div>
          </div>
          <div className="docs">
            <nav className="toc" aria-label="Tools">
              {groups.map((g) => (
                <div key={g.key} style={{ display: "contents" }}>
                  <div className="group">{g.title}</div>
                  {tools
                    .filter((t) => t.group === g.key)
                    .map((t) => (
                      <a key={t.name} href={`#${t.name}`}>
                        {t.name}
                      </a>
                    ))}
                </div>
              ))}
              <div className="group">Setup</div>
              <a href="#connect" className="plain">
                Connect a client
              </a>
            </nav>
            <TocSpy selector=".toc" />

            <div className="docs-main">
              <section className="docs-section">
                <h2>What the server tells clients</h2>
                <div className="card server-says">
                  <Sentences text={catalog.server.instructions} />
                </div>
              </section>

              {q && tools.length === 0 && (
                <section className="docs-section">
                  <div className="empty">
                    No tool or parameter name contains <code>{q}</code>.{" "}
                    <Link href="/mcp">Show all {catalog.tools.length} tools</Link>
                  </div>
                </section>
              )}

              {groups.map((g) => (
                <section key={g.key} className="docs-section" id={`group-${g.key}`}>
                  <h2>
                    {g.title} <span className="count">{tools.filter((t) => t.group === g.key).length}</span>
                    {g.blurb && <span className="count">· {g.blurb}</span>}
                  </h2>
                  <div className="tool-list">
                    {tools
                      .filter((t) => t.group === g.key)
                      .map((t) => (
                        <ToolCard key={t.name} tool={t} />
                      ))}
                  </div>
                </section>
              ))}

              <ConnectClient desktopJson={desktopJson} claudeCodeCmd={claudeCodeCmd} />
            </div>
          </div>
        </>
      )}
      {!catalog && <ConnectClient desktopJson={desktopJson} claudeCodeCmd={claudeCodeCmd} />}
    </>
  );
}

function ConnectClient({ desktopJson, claudeCodeCmd }: { desktopJson: string; claudeCodeCmd: string }) {
  // Shown verbatim, not tilde-shortened: Claude Desktop spawns the server without a shell and
  // never expands "~", so a snippet read off the screen must already hold absolute paths.
  return (
    <section id="connect" className="docs-section connect">
      <h2>Connect a client</h2>
      <div className="connect-grid">
        <div className="connect-box">
          <h3>Claude Desktop / Cowork</h3>
          <div className="cmd">
            <pre className="block">{desktopJson}</pre>
            <CopyButton text={desktopJson} />
          </div>
          <div className="side-note">
            Add to <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>, then restart the app.
            Keep the paths absolute: the app does not expand <code>~</code>.
          </div>
        </div>
        <div className="connect-box">
          <h3>Claude Code</h3>
          <div className="cmd">
            <pre className="block">{claudeCodeCmd}</pre>
            <CopyButton text={claudeCodeCmd} />
          </div>
          <div className="side-note">
            Any project, one command. Hosts keep the server process alive and load it once: after{" "}
            <code>npm run build</code>, restart the host. Config under <code>config/</code> needs no restart.
          </div>
        </div>
      </div>
    </section>
  );
}

/** Split a sentence into [first, rest]. Tool descriptions are written for the model as one paragraph. */
function splitFirstSentence(text: string): [string, string] {
  const m = /^(.*?[.!?])(\s+)(?=[A-Z"'`(])/s.exec(text);
  if (!m || m[1]!.length < 20) return [text, ""];
  return [m[1]!, text.slice(m[0].length)];
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'`(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The long server instructions as a list, one sentence per line. */
function Sentences({ text }: { text: string }) {
  const parts = sentences(text);
  if (parts.length <= 2) return <div>{text}</div>;
  return (
    <ul>
      {parts.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ul>
  );
}

function ToolCard({ tool }: { tool: ToolCatalogEntry }) {
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const names = Object.keys(props);
  const [first, rest] = splitFirstSentence(tool.description);
  const restParts = rest ? sentences(rest) : [];
  return (
    <div className="card tool" id={tool.name}>
      <div className="tool-head">
        <a href={`#${tool.name}`} className="tool-name">
          {tool.name}
        </a>
        {tool.title && <span className="tool-title">{tool.title}</span>}
      </div>
      <div className="tool-desc">
        {first}
        {restParts.length > 0 && (
          <>
            {" "}
            <details className="desc" style={{ display: "inline" }}>
              <summary>more…</summary>
              <ul>
                {restParts.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </details>
          </>
        )}
      </div>
      {names.length === 0 ? (
        <div className="no-params">No parameters.</div>
      ) : (
        <table className="params">
          <thead>
            <tr>
              <th className="col-name">Parameter</th>
              <th className="col-type">Type</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {names.map((n) => {
              const s = props[n]!;
              return (
                <tr key={n}>
                  <td>
                    <code>{n}</code>
                    {required.has(n) && <span className="req">required</span>}
                  </td>
                  <td className="type">{typeOf(s)}</td>
                  <td>
                    {s.description ?? null}
                    {s.enum && <div className="sub mono">one of: {s.enum.map(String).join(" | ")}</div>}
                    {s.default !== undefined && <div className="sub">default: {JSON.stringify(s.default)}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function typeOf(s: JsonSchema): string {
  if (s.enum) return "enum";
  if (s.anyOf) return s.anyOf.map(typeOf).join(" | ");
  if (Array.isArray(s.type)) return s.type.join(" | ");
  if (s.type === "array") return `${s.items ? typeOf(s.items) : "any"}[]`;
  let t = s.type ?? "any";
  if (s.minimum !== undefined || s.maximum !== undefined) t += ` ${s.minimum ?? ""}–${s.maximum ?? ""}`;
  return t;
}
