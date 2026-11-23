#!/usr/bin/env bash
# Runs the full test suite N times and reports failures per run.
# Usage: scripts/tests/repeat-suite.sh [runs=10] [log-dir=<temp>/suite-runs]
# One green run does not prove stability; use this before committing or opening a PR.
set -uo pipefail

runs="${1:-10}"
logdir="${2:-${TMPDIR:-/tmp}/suite-runs-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$logdir"

failed=0
for i in $(seq 1 "$runs"); do
  log="$logdir/run-$i.log"
  node --import tsx --test tests/*.test.ts > "$log" 2>&1
  if grep -q '^# fail 0' "$log"; then
    echo "run $i: ok $(grep -E '^# pass' "$log")"
  else
    failed=$((failed + 1))
    echo "run $i: FAIL $(grep -h '^not ok' "$log" | sed 's/^not ok [0-9]* - //' | tr '\n' ';')"
    grep -ah 'EBUSY\|code:' "$log" | head -2
  fi
done

echo "failed runs: $failed/$runs (logs: $logdir)"
[ "$failed" -eq 0 ]
