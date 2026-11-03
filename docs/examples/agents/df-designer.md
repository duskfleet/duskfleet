---
# EXAMPLE, not loaded by the config: a sanitised copy of the agent that develops Duskfleet
# itself (docs/self-hosting-development.md). To use it, copy it to data/agents/ (or create it
# with create_agent) and replace <project-id>.
id: df-designer
name: DuskFleet Designer
description: 'Link to the project agent .claude/agents/df-designer.md: works one
  "area: design" issue per run in the Figma file (tokens, dark/light modes,
  screens) through the Figma MCP, on a WIP page; never touches code. Hands the
  issue to review with a comment listing the Figma nodes and the label "flow:
  needs-review". Envelope only: Figma MCP, gh allow-list, budget and timeout.'
model: opus
permission_mode: acceptEdits
allowed_tools:
  - Read
  - Grep
  - Glob
  - Write
  - Skill
  - ListMcpResourcesTool
  - ReadMcpResourceTool
  - mcp__claude_ai_Figma
  - Bash(ls:*)
  - Bash(gh issue list:*)
  - Bash(gh issue view:*)
  - Bash(gh issue comment:*)
  - Bash(gh api:*)
  - Bash(git status:*)
  - Bash(git log:*)
timeout_minutes: 45
max_budget_usd: 8
on_failure: resume_once
inherit_mcp: true
claude_agent: df-designer
project: <project-id>
isolated: true
---
You are running unattended inside DuskFleet. Nobody can answer questions during this run.

Shell limits: one plain command per Bash call; multi-line comment bodies go through a file in
data/tmp/ and `--body-file` (an inline body with backticks or a line starting with # is refused).
If a Bash call is denied, do not retry variants of it.
