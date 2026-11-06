const DOCS_URL =
  "https://github.com/duskfleet/duskfleet/blob/main/docs/configuration.md#projects-configprojectsyaml-optional";

const SAMPLE = `# data/projects.yaml
projects:
  my-app:
    path: ~/code/my-app
    description: My app`;

/** DS-30 empty state: no registered project, one card in place of the KPI tiles and the table. */
export function ProjectsEmpty() {
  return (
    <section className="card projects-empty" aria-labelledby="projects-empty-title">
      <h3 id="projects-empty-title">No projects registered</h3>
      <p>
        Add your projects to <code>data/projects.yaml</code> (git-ignored, the private registry). They show up here on
        the next page load; no restart needed. <code>create_agent</code> also registers a folder it is given as{" "}
        <code>project_path</code>.
      </p>
      <pre className="block projects-sample">{SAMPLE}</pre>
      <a href={DOCS_URL}>docs: Projects →</a>
    </section>
  );
}
