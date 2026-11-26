// Checks streamDiff output against direct git output for every file. Usage:
//   node --import tsx scripts/diff-perf/verify-stream-against-git.mts <repo-path>
// Tracked files: patch and additions must equal `git diff <base>` for that path.
// Untracked files: additions must equal the number of lines in the file.
// Exit code 0 when no mismatches are found.
import { execFileSync } from 'node:child_process';
import { lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { streamDiff } from '../../src/git/index.ts';

const root = process.argv[2];
if (!root) {
  console.error('usage: verify-stream-against-git.mts <repo-path>');
  process.exit(2);
}

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 });

const files: { path: string; oldPath?: string; status: string; patch: string; additions: number }[] = [];
let base = '';
for await (const event of streamDiff(root, 'working')) {
  if (event.type === 'metadata') base = event.base;
  else files.push(event.file);
}

const countLines = (text: string) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
// `git diff --no-index` exits 1 when the files differ, which execFileSync reports as an error.
const noIndexNumstat = (path: string) => {
  try {
    return git('diff', '--no-index', '--numstat', '--no-ext-diff', '--no-textconv', '--', '/dev/null', `./${path}`);
  } catch (error) {
    if ((error as { status?: number }).status === 1) return String((error as { stdout?: string }).stdout ?? '');
    throw error;
  }
};

// Untracked paths come from Git itself: status "A" alone also matches staged additions.
const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
const untrackedSet = new Set(untracked);

const problems: string[] = [];
const seen = new Set<string>();
for (const file of files) {
  if (seen.has(file.path)) problems.push(`duplicate ${file.path}`);
  seen.add(file.path);

  if (!untrackedSet.has(file.path)) {
    // Tracked and staged files, including staged additions, are compared against `git diff <base>`.
    const pathspecs = (file.oldPath ? [file.oldPath, file.path] : [file.path]).map(path => `:(literal)${path}`);
    const expected = git('diff', '--no-ext-diff', '--no-textconv', '--find-renames', base, '--', ...pathspecs);
    if (expected !== file.patch) problems.push(`patch differs: ${file.path}`);
    const numstat = git('diff', '--numstat', '--no-ext-diff', '--no-textconv', '--find-renames', base, '--', ...pathspecs).trim().split('\t');
    if (numstat[0] !== '-' && Number(numstat[0]) !== file.additions) problems.push(`additions differ: ${file.path}`);
  } else if (lstatSync(join(root, file.path)).isSymbolicLink()) {
    // An untracked symlink is diffed as its target text, even when the target does not exist.
    const lines = countLines(readlinkSync(join(root, file.path)));
    if (file.additions !== lines) problems.push(`untracked symlink additions ${file.additions} != target lines ${lines}: ${file.path}`);
  } else {
    // Binary files report "-" in numstat and must stream with zero additions.
    const added = noIndexNumstat(file.path).split('\t')[0];
    const expected = added === '-' ? 0 : Number(added);
    if (file.additions !== expected) problems.push(`untracked additions ${file.additions} != numstat ${expected}: ${file.path}`);
  }
}

const streamedPaths = new Set(files.map(file => file.path));
for (const path of untracked) {
  // Nested repositories appear as directories and have no file diff.
  if (lstatSync(join(root, path), { throwIfNoEntry: false })?.isDirectory()) continue;
  if (!streamedPaths.has(path)) problems.push(`untracked missing from stream: ${path}`);
}

console.log(`files ${files.length} untracked ${untracked.length} problems ${problems.length}`);
for (const problem of problems.slice(0, 20)) console.log(`  ${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
