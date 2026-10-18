#!/usr/bin/env bash
# Creates or reuses a build-ready git worktree for one branch, under .claude/worktrees/<name>
# of the MAIN checkout (even when run from inside another worktree).
# Used by the review-fix agent; handy by hand too.
#
#   bash scripts/pr-worktree.sh <name> <branch> <base>
#   bash scripts/pr-worktree.sh pr-12 feat/2-resume-once feat/4-needs-review
#
# - Branch already checked out somewhere (main checkout or another worktree): that path is
#   reused; no second worktree is created.
# - Existing worktree at the target path: reused only if it has <branch> checked out.
# - Branch exists locally or on origin: checked out, then fast-forwarded to origin/<branch>
#   when origin has it (the script fails if the local branch has diverged: fix that by hand,
#   agents never rebase or force-push).
# - Otherwise: new branch from <base> (local branch if present, else origin/<base>).
# node_modules entries are symlinked from the main checkout, except @duskfleet/*, which
# point at the worktree's own packages so builds see the worktree's code.
# Prints the worktree path on the last line.
set -euo pipefail

[ $# -eq 3 ] || { echo "usage: $0 <name> <branch> <base>" >&2; exit 2; }
name=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._\n-' '-')
branch=$2
base=$3

# The main checkout is the parent of the common .git directory, whatever the cwd is.
root=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
wt="$root/.claude/worktrees/$name"

git -C "$root" fetch origin --quiet || echo "warning: git fetch failed, using local refs" >&2

# Where is the branch checked out already, if anywhere?
existing=$(git -C "$root" worktree list --porcelain | awk -v b="refs/heads/$branch" '
  /^worktree / { path = substr($0, 10) }
  /^branch / && $2 == b { print path; exit }')

if [ -n "$existing" ]; then
  echo "branch $branch is already checked out at $existing, reusing it" >&2
  wt=$existing
elif [ -d "$wt" ]; then
  current=$(git -C "$wt" rev-parse --abbrev-ref HEAD)
  if [ "$current" != "$branch" ]; then
    echo "error: $wt exists but has $current checked out, not $branch" >&2
    exit 1
  fi
  echo "reusing $wt" >&2
elif git -C "$root" show-ref --verify --quiet "refs/heads/$branch"; then
  git -C "$root" worktree add "$wt" "$branch"
elif git -C "$root" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
  git -C "$root" worktree add --track -b "$branch" "$wt" "origin/$branch"
else
  ref=$base
  git -C "$root" show-ref --verify --quiet "refs/heads/$base" || ref="origin/$base"
  git -C "$root" worktree add --no-track -b "$branch" "$wt" "$ref"
fi

# Bring the branch up to date with origin when origin has it; refuse a diverged branch.
if git -C "$root" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
  if ! git -C "$wt" merge --ff-only --quiet "origin/$branch"; then
    echo "error: $branch has diverged from origin/$branch in $wt; reconcile it by hand" >&2
    exit 1
  fi
fi
if [ -n "$(git -C "$wt" status --porcelain)" ]; then
  echo "warning: $wt has uncommitted changes from an earlier run" >&2
fi

# Root node_modules: link every entry of the main checkout except @duskfleet.
mkdir -p "$wt/node_modules/@duskfleet"
for entry in "$root"/node_modules/* "$root"/node_modules/.bin; do
  entry_name=$(basename "$entry")
  [ "$entry_name" = "@duskfleet" ] && continue
  [ -e "$wt/node_modules/$entry_name" ] || ln -s "$entry" "$wt/node_modules/$entry_name"
done
for pkg in core:packages/core mcp:packages/mcp web:apps/web; do
  [ -e "$wt/node_modules/@duskfleet/${pkg%%:*}" ] || ln -s "$wt/${pkg#*:}" "$wt/node_modules/@duskfleet/${pkg%%:*}"
done

# apps/web/node_modules of the main checkout (TypeScript 5.x for Next); never commit it.
# A fresh worktree may hold a dangling tracked symlink: replace it.
if [ ! -e "$wt/apps/web/node_modules" ]; then
  [ -L "$wt/apps/web/node_modules" ] && rm "$wt/apps/web/node_modules"
  ln -s "$root/apps/web/node_modules" "$wt/apps/web/node_modules"
fi

# Generated Next types the dashboard typecheck expects (git-ignored).
[ -f "$wt/apps/web/next-env.d.ts" ] || cp "$root/apps/web/next-env.d.ts" "$wt/apps/web/next-env.d.ts" 2>/dev/null || true
if [ -d "$root/apps/web/.next/types" ] && [ ! -d "$wt/apps/web/.next/types" ]; then
  mkdir -p "$wt/apps/web/.next"
  cp -R "$root/apps/web/.next/types" "$wt/apps/web/.next/types"
fi

echo "$wt"
