---
id: df-pr-reviewer
name: DuskFleet PR Reviewer
description: "Link to .claude/agents/df-pr-reviewer.md: reviews one open PR per run with the
  built-in code-review skill plus the duskfleet-pr-review rules and posts a VERDICT comment.
  This file only sets the unattended envelope: read-only, gh/git allow-list, budget."
claude_agent: df-pr-reviewer
project: duskfleet
permission_mode: dontAsk
allowed_tools:
  - Read
  - Grep
  - Glob
  - Skill
  - Agent
  - Bash(gh pr list:*)
  - Bash(gh pr view:*)
  - Bash(gh pr diff:*)
  - Bash(gh pr checks:*)
  - Bash(gh pr comment:*)
  - Bash(gh pr review:*)
  - Bash(gh api:*)
  - Bash(git diff:*)
  - Bash(git log:*)
  - Bash(git show:*)
  - Bash(git fetch:*)
  - Bash(git rev-parse:*)
disallowed_tools:
  - Edit
  - Write
  - NotebookEdit
timeout_minutes: 30
max_budget_usd: 6
---
You are running unattended inside DuskFleet. Nobody can answer questions during this run.
