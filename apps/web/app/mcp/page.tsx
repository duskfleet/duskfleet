import { CopyButton } from "@/components/CopyButton";
import { type JsonSchema, mcpRegistration, type ToolCatalogEntry, toolCatalog } from "@/lib/data";
import { fmtRelative, fmtTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export const metadata = { title: "MCP tools · DuskFleet" };

const GROUPS: Array<{ key: ToolCatalogEntry["group"]; title: string; blurb: string }> = [
  { key: "runs", title: "Runs", blurb: "Start, watch and stop agent executions." },
  { key: "agents", title: "Agents", blurb: "Discover and manage agent definitions (Markdown files in data/agents)." },
  { key: "schedules", title: "Schedules", blurb: "Cron schedules that fire agents unattended." },
  { key: "projects", title: "Projects", blurb: "Registered project directories." },
  { key: "other", title: "Other", blurb: "" },
];

export default function McpPage() {
  const catalog = toolCatalog();
  const reg = mcpRegistration();
  const desktopJson = JSON.stringify(
    { mcpServers: { duskfleet: { command: reg.node, args: [reg.entry], env: { CLAUDE_BIN: reg.claudeBin } } } },
    null,
    2,
  );
  const claudeCodeCmd = `claude mcp add --scope user duskfleet -e CLAUDE_BIN=${reg.claudeBin} -- ${reg.node} ${reg.entry}`;
  const groups = catalog ? GROUPS.filter((g) => catalog.tools.some((t) => t.group === g.key)) : [];

  return (
    <>
      <div className="page-head">
        <h1>MCP tools</h1>
        {catalog && (
          <span className="muted" style={{ fontSize: "0.86rem" }}>
            {catalog.tools.length} tools · server <code>{catalog.server.name}</code> v{catalog.server.version} ·{" "}
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
        <div className="docs">
          <nav className="toc" aria-label="Tools">
            {groups.map((g) => (
              <div key={g.key} style={{ display: "contents" }}>
                <div className="group">{g.title}</div>
                {catalog.tools
                  .filter((t) => t.group === g.key)
                  .map((t) => (
                    <a key={t.name} href={`#${t.name}`}>
                      {t.name}
                    </a>
                  ))}
              </div>
            ))}
            <div className="group">Setup</div>
            <a href="#connect" style={{ fontFamily: "inherit" }}>
              Connect a client
            </a>
          </nav>

          <div style={{ minWidth: 0 }}>
            <div className="card" style={{ marginBottom: 20 }}>
              <div
                className="muted"
                style={{
                  fontSize: "0.8rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.07em",
                  fontWeight: 600,
                  marginBottom: 6,
                }}
              >
                What the server tells clients
              </div>
              <Sentences text={catalog.server.instructions} />
            </div>

            {groups.map((g) => (
              <section key={g.key} style={{ marginBottom: 28 }} id={`group-${g.key}`}>
                <h2 style={{ marginTop: 0 }}>
                  {g.title} <span className="count">{catalog.tools.filter((t) => t.group === g.key).length}</span>
                  {g.blurb && (
                    <span className="count" style={{ fontWeight: 400 }}>
                      · {g.blurb}
                    </span>
                  )}
                </h2>
                <div style={{ display: "grid", gap: 12 }}>
                  {catalog.tools
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
      )}
      {!catalog && <ConnectClient desktopJson={desktopJson} claudeCodeCmd={claudeCodeCmd} />}
    </>
  );
}

function ConnectClient({ desktopJson, claudeCodeCmd }: { desktopJson: string; claudeCodeCmd: string }) {
  // Shown verbatim, not tilde-shortened: Claude Desktop spawns the server without a shell and
  // never expands "~", so a snippet read off the screen must already hold absolute paths.
  return (
    <section id="connect">
      <h2>Connect a client</h2>
      <div className="two-col">
        <div>
          <div className="muted" style={{ fontSize: "0.86rem", marginBottom: 6 }}>
            Claude Desktop / Cowork: add to <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>
            , then restart the app. Keep the paths absolute: the app does not expand <code>~</code>.
          </div>
          <div className="cmd">
            <pre className="block" style={{ whiteSpace: "pre", overflowX: "auto" }}>
              {desktopJson}
            </pre>
            <CopyButton text={desktopJson} />
          </div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: "0.86rem", marginBottom: 6 }}>
            Claude Code (any project, one command):
          </div>
          <div className="cmd">
            <pre className="block" style={{ whiteSpace: "pre", overflowX: "auto" }}>
              {claudeCodeCmd}
            </pre>
            <CopyButton text={claudeCodeCmd} />
          </div>
          <div className="muted" style={{ fontSize: "0.8rem", marginTop: 10 }}>
            Hosts keep the server process alive and load it once: after <code>npm run build</code>, restart the host.
            Config under <code>config/</code>
            needs no restart.
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
  if (parts.length <= 2) return <div style={{ fontSize: "0.95rem" }}>{text}</div>;
  return (
    <ul style={{ margin: 0, paddingLeft: 20, fontSize: "0.92rem", display: "grid", gap: 4 }}>
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
    <div className="card" id={tool.name}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <a href={`#${tool.name}`} style={{ color: "inherit" }}>
          <code style={{ fontSize: "1rem", fontWeight: 650 }}>{tool.name}</code>
        </a>
        {tool.title && <span className="muted">{tool.title}</span>}
      </div>
      <div style={{ margin: "8px 0 10px", fontSize: "0.92rem" }}>
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
        <div className="muted" style={{ fontSize: "0.86rem" }}>
          No parameters.
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: "22%" }}>Parameter</th>
              <th style={{ width: "18%" }}>Type</th>
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
                    {required.has(n) && (
                      <span className="tag" style={{ marginLeft: 6 }}>
                        required
                      </span>
                    )}
                  </td>
                  <td className="mono muted">{typeOf(s)}</td>
                  <td style={{ fontSize: "0.88rem" }}>
                    {s.description ?? null}
                    {s.enum && (
                      <div className="mono muted" style={{ fontSize: "0.8rem", marginTop: 3 }}>
                        one of: {s.enum.map(String).join(" | ")}
                      </div>
                    )}
                    {s.default !== undefined && (
                      <div className="muted" style={{ fontSize: "0.8rem" }}>
                        default: {JSON.stringify(s.default)}
                      </div>
                    )}
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
