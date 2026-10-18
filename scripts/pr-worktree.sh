#!/usr/bin/env bash
# Creates or reuses a build-ready git worktree for one branch, under .claude/worktrees/<name>.
# Used by the review-fix agent (skill duskfleet-pr-fix); handy by hand too.
#
#   bash scripts/pr-worktree.sh <name> <branch> <base>
#   bash scripts/pr-worktree.sh pr-12 feat/2-resume-once feat/4-needs-review
#
# - Existing worktree: reused as is.
# - Branch exists locally or on origin: checked out.
# - Otherwise: new branch from <base> (local branch if present, else origin/<base>).
# node_modules entries are symlinked from the main checkout, except @duskfleet/*, which
# point at the worktree's own packages so builds see the worktree's code.
# Prints the worktree path on the last line.
set -euo pipefail

[ $# -eq 3 ] || { echo "usage: $0 <name> <branch> <base>" >&2; exit 2; }
name=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._-\n' '-')
branch=$2
base=$3

root=$(git rev-parse --show-toplevel)
wt="$root/.claude/worktrees/$name"

git -C "$root" fetch origin --quiet || echo "warning: git fetch failed, using local refs" >&2

if [ -d "$wt" ]; then
  echo "reusing $wt"
  git -C "$wt" pull --ff-only --quiet || echo "warning: fast-forward of $branch failed, worktree left as is" >&2
elif git -C "$root" show-ref --verify --quiet "refs/heads/$branch"; then
  git -C "$root" worktree add "$wt" "$branch"
elif git -C "$root" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
  git -C "$root" worktree add --track -b "$branch" "$wt" "origin/$branch"
else
  ref=$base
  git -C "$root" show-ref --verify --quiet "refs/heads/$base" || ref="origin/$base"
  git -C "$root" worktree add --no-track -b "$branch" "$wt" "$ref"
fi

# Root node_modules: link every entry of the main checkout except @duskfleet.
mkdir -p "$wt/node_modules/@duskfleet"
for entry in "$root"/node_modules/* "$root"/node_modules/.bin; do
  name_=$(basename "$entry")
  [ "$name_" = "@duskfleet" ] && continue
  [ -e "$wt/node_modules/$name_" ] || ln -s "$entry" "$wt/node_modules/$name_"
done
for pkg in core:packages/core mcp:packages/mcp web:apps/web; do
  [ -e "$wt/node_modules/@duskfleet/${pkg%%:*}" ] || ln -s "$wt/${pkg#*:}" "$wt/node_modules/@duskfleet/${pkg%%:*}"
done

# apps/web/node_modules of the main checkout (TypeScript 5.x for Next); never commit it.
if [ ! -e "$wt/apps/web/node_modules" ]; then
  ln -s "$root/apps/web/node_modules" "$wt/apps/web/node_modules"
fi

# Generated Next types the dashboard typecheck expects (git-ignored).
[ -f "$wt/apps/web/next-env.d.ts" ] || cp "$root/apps/web/next-env.d.ts" "$wt/apps/web/next-env.d.ts" 2>/dev/null || true
if [ -d "$root/apps/web/.next/types" ] && [ ! -d "$wt/apps/web/.next/types" ]; then
  mkdir -p "$wt/apps/web/.next"
  cp -R "$root/apps/web/.next/types" "$wt/apps/web/.next/types"
fi

echo "$wt"
