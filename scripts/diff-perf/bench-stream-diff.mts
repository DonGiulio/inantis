// Times streamDiff over a repository. Usage:
//   node --import tsx scripts/diff-perf/bench-stream-diff.mts <repo-path> [runs]
// Build a test repo first with create-bench-repo.sh.
import { streamDiff } from '../../src/git/index.ts';

const root = process.argv[2];
const runs = Number(process.argv[3] ?? 3);
if (!root) {
  console.error('usage: bench-stream-diff.mts <repo-path> [runs]');
  process.exit(2);
}

for (let r = 0; r < runs; r++) {
  const started = performance.now();
  let files = 0;
  for await (const event of streamDiff(root, 'working')) if (event.type === 'file') files++;
  console.log(`run ${r} files ${files} ms ${Math.round(performance.now() - started)}`);
}
