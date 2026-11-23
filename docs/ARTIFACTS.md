# Artifacts index

Where things are, what they are, and the identifiers and URLs they depend on. Numbers and reasoning live in [WORKLOG.md](WORKLOG.md); commands live in [RUNBOOK.md](RUNBOOK.md).

## In the repository

| Path | What it is |
|---|---|
| `docs/RUNBOOK.md` | Verified commands for build, tests, benchmarks, HEAD baselines, git and push |
| `docs/WORKLOG.md` | Goals, results, decisions, failed attempts, open items |
| `docs/ARTIFACTS.md` | This index |
| `scripts/diff-perf/create-bench-repo.sh` | Creates a 200-tracked, 60-untracked file bench repo in an empty directory |
| `scripts/diff-perf/bench-stream-diff.mts` | Times `streamDiff` over a repo |
| `scripts/diff-perf/verify-stream-against-git.mts` | Checks streamed patches and counts against direct git output; exit 1 on mismatch |
| `scripts/diff-perf/find-failing-diff-entry.mts` | Reports the first entry that makes `streamDiff` throw |
| `scripts/tests/repeat-suite.sh` | Runs the full suite N times and reports failures per run |
| `CHANGELOG.md` | "Unreleased" entries for this branch |

## Identifiers

| Item | Value |
|---|---|
| Git remote (`origin`) | `https://github.com/DonGiulio/inantis.git` |
| Feature branch | `feature/cross-platform-tests-coverage` |
| Base branch for PR | `main` |
| Git version | 2.56.0.windows.4 |
| Node version | 22.22.0 |
| Windows error `0xC0000142` | `STATUS_DLL_INIT_FAILED`, seen as `git rev-parse failed with exit code 3221225794` |
| Windows error `EBUSY` | Directory locked during `rmdir`; seen in `diff-context.test.ts` |

## URLs

| URL | Use |
|---|---|
| `https://github.com/DonGiulio/inantis.git` | Remote for push and PR |
| `https://github.com/DonGiulio/inantis` | Repository page (PR target) |
| `http://127.0.0.1:<port>` | Local review server. The port changes each time `npm start` runs; it is not a stable URL |

Install URLs from the README (`npm exec --package=git+https://github.com/DonGiulio/inantis.git`, plugin marketplace `DonGiulio/inantis`) are unchanged.
