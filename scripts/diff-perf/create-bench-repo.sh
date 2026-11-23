#!/usr/bin/env bash
# Creates a git repo with 200 modified tracked files and 60 untracked files.
# Usage: scripts/diff-perf/create-bench-repo.sh <new-empty-dir>
# Use a scratch directory outside the project; the script refuses non-empty targets.
set -euo pipefail

target="${1:?usage: create-bench-repo.sh <new-empty-dir>}"
if [ -e "$target" ] && [ -n "$(ls -A "$target" 2>/dev/null)" ]; then
  echo "refusing: $target exists and is not empty" >&2
  exit 1
fi
mkdir -p "$target"
cd "$target"

git init -q
git config user.email bench@example.com
git config user.name bench

for i in $(seq 1 200); do printf 'a\nb\nc\n' > "f$i.txt"; done
git add .
git commit -q -m base

for i in $(seq 1 200); do printf 'a\nX%s\nc\n' "$i" > "f$i.txt"; done
for i in $(seq 1 60); do printf 'u\n' > "u$i.txt"; done

echo "bench repo ready: $(pwd)"
