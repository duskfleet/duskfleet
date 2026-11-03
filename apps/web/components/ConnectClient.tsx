import type { CSSProperties } from "react";
import { CopyButton } from "./CopyButton";

export interface ConnectClientProps {
  /** Claude Desktop snippet (`{ "mcpServers": { "duskfleet": ... } }`); null when the server entry is unknown. */
  desktopJson: string | null;
  /** `claude mcp add ...` for Claude Code; null when the server entry is unknown. */
  claudeCodeCmd: string | null;
  /** Claude Desktop's config file on this OS. */
  desktopConfigPath: string;
  /** The dashboard runs from the repo checkout: a rebuild needs a host restart. */
  checkout: boolean;
  /** `mcp register` for this install, shown when the entry is unknown. */
  registerCmd: string;
}

/**
 * The /mcp page's "Connect a client" card: the same entry `duskfleet mcp register --dry-run`
 * prints (core's `mcpServerConfig`). Shown verbatim, not tilde-shortened: Claude Desktop spawns
 * the server without a shell and never expands "~", so a snippet read off the screen must
 * already hold absolute paths.
 */
export function ConnectClient({
  desktopJson,
  claudeCodeCmd,
  desktopConfigPath,
  checkout,
  registerCmd,
}: ConnectClientProps) {
  return (
    <section id="connect" className="docs-section connect">
      <h2>Connect a client</h2>
      {desktopJson === null || claudeCodeCmd === null ? (
        <div className="callout warn">
          <span className="icon">!</span>
          <div>
            <strong>This install&apos;s MCP server was not found.</strong> The dashboard was not started by{" "}
            <code>duskfleet dashboard</code>. Let the CLI write the entry instead:
            <div className="cmd">
              <WrappedCode text={registerCmd} />
              <CopyButton text={registerCmd} />
            </div>
          </div>
        </div>
      ) : (
        <div className="connect-grid">
          <div className="connect-box">
            <h3>Claude Desktop / Cowork</h3>
            <div className="cmd">
              <WrappedCode text={desktopJson} />
              <CopyButton text={desktopJson} />
            </div>
            <div className="side-note">
              Add to <code>{desktopConfigPath}</code>, then restart the app. Keep the paths absolute: the app does not
              expand <code>~</code>.
            </div>
          </div>
          <div className="connect-box">
            <h3>Claude Code</h3>
            <div className="cmd">
              <WrappedCode text={claudeCodeCmd} />
              <CopyButton text={claudeCodeCmd} />
            </div>
            <div className="side-note">
              Any project, one command.{" "}
              {checkout ? (
                <>
                  Hosts keep the server process alive and load it once: after <code>npm run build</code>, restart the
                  host. Config under <code>config/</code> needs no restart.
                </>
              ) : (
                <>
                  Hosts keep the server process alive and load it once: after an upgrade, restart the host. Config
                  changes need no restart.
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * A snippet that wraps with a hanging indent: one block per source line, its leading spaces moved
 * into --ind so continuation lines sit 2ch past the line's own indentation (text-indent only
 * acts on a block's first line). A <wbr> after each "/" lets long paths break at a segment.
 * Display only: the Copy button copies the original text.
 */
function WrappedCode({ text }: { text: string }) {
  return (
    <pre className="block">
      {text.split("\n").map((line, i) => {
        const body = line.trimStart();
        const parts = body.split("/");
        return (
          <span key={i} className="ln" style={{ "--ind": `${line.length - body.length}ch` } as CSSProperties}>
            {parts.map((p, j) => (
              <span key={j}>
                {p}
                {j < parts.length - 1 && (
                  <>
                    /<wbr />
                  </>
                )}
              </span>
            ))}
          </span>
        );
      })}
    </pre>
  );
}
