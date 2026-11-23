// Checks streamDiff output against direct git output for every file. Usage:
//   node --import tsx scripts/diff-perf/verify-stream-against-git.mts <repo-path>
// Tracked files: patch and additions must equal `git diff <base>` for that path.
// Untracked files: additions must equal the number of lines in the file.
// Exit code 0 when no mismatches are found.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { streamDiff } from '../../src/git/index.ts';

const root = process.argv[2];
if (!root) {
  console.error('usage: verify-stream-against-git.mts <repo-path>');
  process.exit(2);
}

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 });

const files: { path: string; status: string; patch: string; additions: number }[] = [];
let base = '';
for await (const event of streamDiff(root, 'working')) {
  if (event.type === 'metadata') base = event.base;
  else files.push(event.file);
}

const problems: string[] = [];
const seen = new Set<string>();
for (const file of files) {
  if (seen.has(file.path)) problems.push(`duplicate ${file.path}`);
  seen.add(file.path);

  const pathspec = `:(literal)${file.path}`;
  if (file.status !== 'A') {
    const expected = git('diff', '--no-ext-diff', '--no-textconv', '--find-renames', base, '--', pathspec);
    if (expected !== file.patch) problems.push(`patch differs: ${file.path}`);
    const numstat = git('diff', '--numstat', '--no-ext-diff', '--no-textconv', base, '--', pathspec).trim().split('\t');
    if (numstat[0] !== '-' && Number(numstat[0]) !== file.additions) problems.push(`additions differ: ${file.path}`);
  } else {
    const text = readFileSync(join(root, file.path), 'utf8');
    const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    if (file.additions !== lines) problems.push(`untracked additions ${file.additions} != lines ${lines}: ${file.path}`);
  }
}

const untracked = git('ls-files', '--others', '--exclude-standard').trim().split('\n').filter(Boolean);
const streamedUntracked = files.filter(file => file.status === 'A').map(file => file.path);
for (const path of untracked) if (!streamedUntracked.includes(path)) problems.push(`untracked missing from stream: ${path}`);

console.log(`files ${files.length} untracked ${untracked.length} problems ${problems.length}`);
for (const problem of problems.slice(0, 20)) console.log(`  ${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
