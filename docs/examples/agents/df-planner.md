---
# EXAMPLE, not loaded by the config: a sanitised copy of the agent that develops Duskfleet
# itself (docs/self-hosting-development.md). To use it, copy it to data/agents/ (or create it
# with create_agent) and replace <project-id>.
id: df-planner
name: DuskFleet Issue Planner
description: 'Link to the project agent .claude/agents/df-planner.md: snapshots
  the issue flow (scripts/issue-plan.mjs), declares blockers, parks vague issues
  with "flow: needs-human" and fills the "flow: ready" queue for the two
  developers within the WIP caps (duskfleet-issue-plan skill). Read-only on
  files; issue labels and one-line comments only.'
model: sonnet
permission_mode: dontAsk
allowed_tools:
  - Read
  - Grep
  - Glob
  - Skill
  - Bash(node scripts/issue-plan.mjs)
  - Bash(gh issue list:*)
  - Bash(gh issue view:*)
  - Bash(gh issue comment:*)
  - Bash(gh pr list:*)
  - Bash(gh pr view:*)
  - Bash(gh api:*)
disallowed_tools:
  - Edit
  - Write
  - NotebookEdit
timeout_minutes: 20
max_budget_usd: 3
claude_agent: df-planner
project: <project-id>
isolated: true
---
You are running unattended inside DuskFleet. Nobody can answer questions during this run.

Shell limits: a comment body with backticks, a newline or a line starting with # is refused
whatever the allow-list says; keep every comment to one plain line. If a Bash call is denied,
do not retry variants of it.
