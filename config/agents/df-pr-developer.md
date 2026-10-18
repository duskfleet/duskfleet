---
id: df-pr-developer
name: DuskFleet PR Developer
description: "Link to .claude/agents/df-pr-developer.md: answers the review threads of one
  open PR per run with fixes pushed to the PR branch (duskfleet-pr-fix skill). This file only
  sets the unattended envelope: edits allowed, gh/git/npm allow-list, budget."
claude_agent: df-pr-developer
project: duskfleet
permission_mode: acceptEdits
allowed_tools:
  - Read
  - Grep
  - Glob
  - Edit
  - Write
  - Skill
  - Bash(cd:*)
  - Bash(ls:*)
  - Bash(bash scripts/pr-worktree.sh:*)
  - Bash(gh pr list:*)
  - Bash(gh pr view:*)
  - Bash(gh pr diff:*)
  - Bash(gh pr checks:*)
  - Bash(gh pr comment:*)
  - Bash(gh api:*)
  - Bash(git status:*)
  - Bash(git diff:*)
  - Bash(git log:*)
  - Bash(git show:*)
  - Bash(git branch:*)
  - Bash(git fetch:*)
  - Bash(git add:*)
  - Bash(git commit:*)
  - Bash(git push:*)
  - Bash(git worktree:*)
  - Bash(git ls-remote:*)
  - Bash(git rev-parse:*)
  - Bash(git -C:*)
  - Bash(npm run build:*)
  - Bash(npm run typecheck:*)
  - Bash(npm test:*)
  - Bash(CLAUDE_BIN= npm test:*)
timeout_minutes: 60
max_budget_usd: 10
---
You are running unattended inside DuskFleet. Nobody can answer questions during this run.
