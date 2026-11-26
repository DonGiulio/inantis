// Streams the diff and reports the first entry that makes streamDiff throw.
// Used to find the untracked nested-repository bug ("Unexpected git numstat output").
// Usage: node --import tsx scripts/diff-perf/find-failing-diff-entry.mts <repo-path>
import { streamDiff } from '../../src/git/index.ts';

const root = process.argv[2];
if (!root) {
  console.error('usage: find-failing-diff-entry.mts <repo-path>');
  process.exit(2);
}

let count = 0;
try {
  for await (const event of streamDiff(root, 'working')) {
    if (event.type === 'file') {
      count++;
      console.log('ok:', event.file.path, event.file.status, event.file.additions, event.file.deletions);
    }
  }
  console.log(`no error; ${count} files streamed`);
} catch (error) {
  console.log(`THREW after ${count} files: ${(error as Error).message}`);
  process.exit(1);
}
