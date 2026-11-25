# Runbook

Commands verified on Windows 11 with Node 22.22, Git 2.56, PowerShell or Git Bash. Run from the repository root unless noted.

## Setup

```sh
npm install
```

## Run the review server

Development (hot reload, opens the browser):

```sh
npm run dev
```

Built server (serves `dist/`, prints the URL):

```sh
npm run build
npm start
```

Run `npm run build` after any change to `src/`. `npm start` does not rebuild. Stop with `Ctrl+C`. In a background task, stop it by task ID; never kill `node.exe` by image name.

## Tests

Full suite (same as `npm test`):

```sh
node --import tsx --test tests/*.test.ts
```

Single file, or a single test by name:

```sh
node --import tsx --test tests/git-stream.test.ts
node --import tsx --test --test-name-pattern="nested repositories" tests/git-stream.test.ts
```

Type-check the server:

```sh
npx tsc -p tsconfig.server.json --noEmit
```

Before pushing, check for flakiness. One green run is not enough:

```sh
bash scripts/tests/repeat-suite.sh 10
```

It prints each run and the failure count, and keeps the logs. Each full run takes about 10 to 15 seconds, so 10 runs take about 2.5 minutes; run it as a background task to avoid the 120-second shell timeout.

## Check diff output against git

The streamed diff must match direct git output. Compare patches and counts for one file:

```sh
git diff --no-ext-diff --no-textconv --find-renames <base> -- ':(literal)<path>'
git diff --numstat --no-ext-diff --no-textconv <base> -- ':(literal)<path>'
```

Use `HEAD` as `<base>` for the working-tree mode.

## Benchmark streamed diff

Scripts live in `scripts/diff-perf/`. Create the bench repo in an empty scratch directory outside the project, then time it:

```sh
bash scripts/diff-perf/create-bench-repo.sh <scratch>/bench
node --import tsx scripts/diff-perf/bench-stream-diff.mts <scratch>/bench 3
```

Expected on this machine: about 6.3 s with `FILE_CONCURRENCY = 1` and about 1.3 to 1.5 s with `FILE_CONCURRENCY = 8`.

Verify streamed output against git on the same repo (exit code 0 means no mismatches):

```sh
node --import tsx scripts/diff-perf/verify-stream-against-git.mts <scratch>/bench
```

If `streamDiff` throws, find the entry that causes it:

```sh
node --import tsx scripts/diff-perf/find-failing-diff-entry.mts <repo>
```

## Baseline a suspected regression against HEAD

Use a separate worktree. Do not touch the main working tree:

```sh
git worktree add --detach <scratch>/head-wt HEAD
cd <scratch>/head-wt && npm ci
node --import tsx --test tests/*.test.ts
```

To isolate source changes, copy only `src/` or the tests you need. Clean up when finished:

```sh
git worktree remove --force <scratch>/head-wt
git worktree prune
```

## Git and GitHub

Commit only the intended files. `.tmp/` is untracked scratch output and stays out of commits:

```sh
git status --short
git add src/... tests/...
git commit -F <message-file>
```

Push the feature branch:

```sh
git push -u fork feature/cross-platform-tests-coverage
```

Opening the PR (`gh pr create --base main`) needs the push to succeed first. The `origin` remote is `DonGiulio/inantis`. The fork remote points to hedoluna/inantis.

## Known problems

| Symptom | Cause | Action |
|---|---|---|
| `EBUSY: resource busy or locked, rmdir` in `diff-context.test.ts` | Windows file lock during temp-dir cleanup | Cleanup uses `maxRetries: 5`; rerun if it still appears |
| `git rev-parse failed with exit code 3221225794` in the UI | `0xC0000142` (DLL init failed) when launching `git.exe`; not reproduced | Reload the page; if it repeats, record the URL and time |
| Push returns 403 | Account lacks Write access | See Git and GitHub above |
| Bash command blocked by hook on `node_modules` text | Hook pattern on command text | Avoid the literal string in commands; do not rename it to get around the hook |
