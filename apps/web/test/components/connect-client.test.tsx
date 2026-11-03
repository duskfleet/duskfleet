import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectClient, type ConnectClientProps } from "../../components/ConnectClient";

const desktopJson = '{\n  "mcpServers": {\n    "duskfleet": {\n      "command": "/usr/bin/node"\n    }\n  }\n}';
const claudeCodeCmd = "claude mcp add duskfleet -s user -- /usr/bin/node /opt/duskfleet/dist/index.js";

function render(props: Partial<ConnectClientProps>): string {
  return renderToStaticMarkup(
    <ConnectClient
      desktopJson={desktopJson}
      claudeCodeCmd={claudeCodeCmd}
      desktopConfigPath="/srv/config/Claude/claude_desktop_config.json"
      checkout={false}
      registerCmd="duskfleet mcp register"
      {...props}
    />,
  );
}

/** The text a reader sees, without tags (the snippets carry a <wbr> after each "/"). */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}

test("ConnectClient: with the entry, one box per client with its snippet and a Copy button each", () => {
  const html = render({});
  assert.deepEqual(
    [...html.matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => m[1]),
    ["Claude Desktop / Cowork", "Claude Code"],
  );
  assert.equal((html.match(/class="copy-btn ">Copy<\/button>/g) ?? []).length, 2);
  const seen = text(html);
  // Each line's leading spaces become its --ind hanging indent, not text.
  const lines = desktopJson.split("\n").map((l) => l.trimStart());
  assert.ok(seen.includes(lines.join("")), "Desktop JSON shown");
  assert.match(html, /style="--ind:4ch"/);
  assert.ok(seen.includes(claudeCodeCmd), "claude mcp add shown");
  assert.doesNotMatch(html, /was not found/);
});

test("ConnectClient: the Desktop box names this OS's config file, verbatim", () => {
  assert.match(
    render({}),
    /Add to <code>\/srv\/config\/Claude\/claude_desktop_config\.json<\/code>, then restart the app/,
  );
});

test("ConnectClient: in a checkout the restart note is about npm run build and config/", () => {
  const seen = text(render({ checkout: true }));
  assert.match(seen, /after npm run build, restart the host\. Config under config\/ needs no restart\./);
  assert.doesNotMatch(seen, /after an upgrade/);
});

test("ConnectClient: an npm install says to restart after an upgrade", () => {
  const seen = text(render({ checkout: false }));
  assert.match(seen, /after an upgrade, restart the host\. Config changes need no restart\./);
  assert.doesNotMatch(seen, /npm run build/);
});

test("ConnectClient: without the entry, a warning with the mcp register command instead of the snippets", () => {
  for (const missing of [{ desktopJson: null }, { claudeCodeCmd: null }]) {
    const html = render({ ...missing, registerCmd: "npx -y duskfleet mcp register" });
    assert.match(html, /<div class="callout warn">/);
    assert.match(text(html), /This install's MCP server was not found\./);
    assert.match(html, /<span>npx -y duskfleet mcp register<\/span>/);
    assert.equal((html.match(/class="copy-btn ">Copy<\/button>/g) ?? []).length, 1);
    assert.doesNotMatch(html, /<h3>/);
  }
});
