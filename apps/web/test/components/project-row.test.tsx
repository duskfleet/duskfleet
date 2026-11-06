import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectRow } from "../../components/ProjectRow";
import { ProjectsEmpty } from "../../components/ProjectsEmpty";
import type { ProjectSummary } from "../../lib/data";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const HOME = "/home/me";

const project = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: "app",
  path: "/home/me/code/app",
  agents: ["builder"],
  lastRun: { id: "r1", status: "completed", reviewReasons: [], createdAt: "2026-11-05T11:20:00Z" },
  monthRuns: 112,
  monthCostUsd: 23.1,
  ...over,
});

const render = (p: ProjectSummary) =>
  renderToStaticMarkup(
    <table>
      <tbody>
        <ProjectRow project={p} home={HOME} now={NOW} />
      </tbody>
    </table>,
  );

test("ProjectRow: name over the ~/ path, month runs and spend, runs → filtered by the project", () => {
  const html = render(project());
  assert.match(html, /<div class="pr-name">app<\/div><code class="pr-path">~\/code\/app<\/code>/);
  assert.doesNotMatch(html, /\/home\/me/);
  assert.match(html, /<td class="pr-num">112<\/td><td class="pr-num">\$23\.10<\/td>/);
  assert.match(html, /<td class="pr-links"><a href="\/\?project=app">runs →<\/a><\/td>/);
});

test("ProjectRow: two agent chips, then +N with the rest in its title", () => {
  const html = render(project({ agents: ["a1", "a2", "a3", "a4"] }));
  assert.match(html, /<a href="\/agents\/a1" class="ac-tag">a1<\/a><a href="\/agents\/a2" class="ac-tag">a2<\/a>/);
  assert.match(html, /<span class="ac-tag" title="a3, a4">\+2<\/span>/);
  assert.doesNotMatch(html, />a3</);
});

test("ProjectRow: no bound agent says so", () => {
  const html = render(project({ agents: [] }));
  assert.match(html, /<td class="pr-agents"><span class="muted">no agent bound<\/span><\/td>/);
});

test("ProjectRow: completed clean run, green pill and its age", () => {
  const html = render(project());
  assert.match(
    html,
    /<a href="\/runs\/r1" class="badge-link"><span class="badge completed" title="completed">completed<\/span><\/a>/,
  );
  assert.match(html, /<span class="pr-ago" title="[^"]+">40 min ago<\/span>/);
});

test("ProjectRow: a completed run with a review reason is amber, never green", () => {
  const html = render(
    project({
      lastRun: {
        id: "r2",
        status: "completed",
        reviewReasons: ["permission_denied"],
        createdAt: "2026-11-02T12:00:00Z",
      },
    }),
  );
  assert.match(
    html,
    /<span class="badge attention" title="completed · needs review: permission denied">needs review<\/span>/,
  );
  assert.doesNotMatch(html, /badge completed/);
  assert.match(html, />3 d ago</);
});

test("ProjectRow: running and failed last runs", () => {
  const running = render(
    project({ lastRun: { id: "r3", status: "running", reviewReasons: [], createdAt: "2026-11-05T12:00:00Z" } }),
  );
  assert.match(running, /<span class="badge running" title="running">running<\/span>/);
  assert.match(running, /<span class="pr-ago" title="[^"]+">now<\/span>/);
  const failed = render(
    project({ lastRun: { id: "r4", status: "failed", reviewReasons: ["failed"], createdAt: "2026-11-05T09:00:00Z" } }),
  );
  assert.match(failed, /<span class="badge failed" title="failed · needs review: failed">failed<\/span>/);
});

test("ProjectRow: no run yet is the muted none pill, no age", () => {
  const html = render(project({ lastRun: null }));
  assert.match(
    html,
    /<td class="pr-last"><span class="badge none" title="No run on this project yet">none<\/span><\/td>/,
  );
  assert.doesNotMatch(html, /pr-ago/);
});

test("ProjectsEmpty: title, the private registry line, the YAML sample and the docs link", () => {
  const html = renderToStaticMarkup(<ProjectsEmpty />);
  assert.match(html, /<h3 id="projects-empty-title">No projects registered<\/h3>/);
  assert.match(html, /<code>data\/projects\.yaml<\/code> \(git-ignored, the private registry\)/);
  assert.match(html, /<code>create_agent<\/code> also registers a folder/);
  assert.match(html, /<pre class="block projects-sample"># data\/projects\.yaml\nprojects:\n {2}my-app:\n/);
  assert.match(
    html,
    /<a href="https:\/\/github\.com\/duskfleet\/duskfleet\/blob\/main\/docs\/configuration\.md#projects-configprojectsyaml-optional">docs: Projects →<\/a>/,
  );
});
