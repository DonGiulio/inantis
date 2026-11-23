import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../locales/index.js';
import { mapOrdered } from './map-ordered.js';

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
  contextId: string;
  uncommitted: boolean;
}

export interface DiffResult {
  root: string;
  branch: string;
  base: string;
  baseIsEmpty: boolean;
  baseLabel?: string;
  baseRefs: string[];
  baseTags: string[];
  headTags: string[];
  files: DiffFile[];
}

export type DiffEvent =
  | ({ type: 'metadata' } & Omit<DiffResult, 'files'>)
  | { type: 'file'; file: DiffFile };

type Mode = 'working' | 'upstream' | 'branch' | 'ref';

interface GitOutput {
  stdout: string;
  stderr: string;
  code: number;
}

function git(cwd: string, args: string[], input?: string): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-optional-locks', ...args], {
      cwd,
      env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '0' },
      stdio: 'pipe',
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === null) {
        reject(signal ? new AppError('gitTerminated', { signal }) : new AppError('gitTerminatedUnknown'));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function run(cwd: string, args: string[], input?: string): Promise<string> {
  const result = await git(cwd, args, input);
  if (result.code !== 0) {
    throw result.stderr.trim() ? new Error(result.stderr.trim()) : new AppError('gitFailed', { command: args[0], code: result.code });
  }
  return result.stdout;
}

// Remove Git's terminating newline, not whitespace that may belong to a path.
function line(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

export async function repoRoot(cwd: string): Promise<string> {
  return line(await run(cwd, ['rev-parse', '--show-toplevel']));
}

async function commit(root: string, ref: string): Promise<string> {
  // --end-of-options prevents an untrusted ref from becoming a Git option.
  return line(await run(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]));
}

async function branchBase(root: string, branchRef: string | undefined): Promise<{ hash: string; label: string } | undefined> {
  if (branchRef) {
    const log = await git(root, ['reflog', 'show', '--format=%H%x00%gs', branchRef]);
    if (log.code === 0) {
      const entries = log.stdout.trimEnd().split('\n');
      const first = entries[entries.length - 1];
      const separator = first.indexOf('\0');
      if (separator !== -1 && first.slice(separator + 1).startsWith('branch: Created from ')) {
        return { hash: first.slice(0, separator), label: first.slice(separator + 1 + 'branch: Created from '.length) };
      }
    }
  }
  return undefined;
}

const diffOptions = ['--no-ext-diff', '--no-textconv', '--find-renames'];

// Git work for up to this many files runs concurrently; files are still yielded in raw order.
// Files may be read slightly before the consumer asks for them; contextId rejects stale expansions.
const FILE_CONCURRENCY = 8;

interface RawEntry {
  status: string;
  firstPath: string;
  path: string;
  renamed: boolean;
}

// `-p --numstat -z` prints NUL-terminated numstat records, one extra NUL, then the patch.
function splitNumstatPatch(output: string): { stat: string; patch: string } {
  const end = output.indexOf('\0\0');
  if (end === -1) throw new Error('Unexpected git numstat output');
  return { stat: output.slice(0, end), patch: output.slice(end + 2) };
}

function counts(output: string): { additions: number; deletions: number; binary: boolean } {
  const first = output.split('\0', 1)[0];
  const match = /^(\d+|-)\t(\d+|-)\t/.exec(first);
  if (!match) throw new Error('Unexpected git numstat output');
  const binary = match[1] === '-' || match[2] === '-';
  return { additions: binary ? 0 : Number(match[1]), deletions: binary ? 0 : Number(match[2]), binary };
}

/**
 * Compare the selected base to the current working tree, including staged,
 * unstaged and non-ignored untracked files. Branch comparisons use the common
 * ancestor with the supplied or inferred target when it is still available.
 * Binary changes have zero line counts; their patches contain Git's marker.
 */
export async function* streamDiff(root: string, mode: Mode, ref?: string): AsyncGenerator<DiffEvent> {
  root = await repoRoot(root);
  const symbolic = await git(root, ['symbolic-ref', '--quiet', 'HEAD']);
  const branchRef = symbolic.code === 0 ? line(symbolic.stdout) : undefined;
  const headResult = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  const head = headResult.code === 0 ? line(headResult.stdout) : undefined;
  const branch = branchRef?.replace(/^refs\/heads\//, '') ?? (head ? `HEAD (${head.slice(0, 12)})` : 'HEAD');

  let base: string;
  let baseIsEmpty = false;
  let baseLabel: string | undefined;
  const emptyTree = async () => {
    baseIsEmpty = true;
    return line(await run(root, ['hash-object', '-w', '-t', 'tree', '--stdin'], ''));
  };
  if (mode === 'working') {
    base = head ?? await emptyTree();
    baseLabel = head ? 'HEAD' : undefined;
  } else if (mode === 'upstream') {
    const upstream = await git(root, ['rev-parse', '--verify', '--quiet', '@{upstream}^{commit}']);
    if (upstream.code === 0) {
      base = line(upstream.stdout);
      const upstreamName = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
      if (upstreamName.code === 0) baseLabel = line(upstreamName.stdout);
    } else if (head) {
      throw new AppError('noUpstream');
    } else {
      base = await emptyTree();
    }
  } else if (mode === 'branch') {
    const origin = ref ? { hash: await commit(root, ref), label: ref } : await branchBase(root, branchRef);
    if (origin) {
      let target = ref ? origin.hash : undefined;
      if (!ref && origin.label !== 'HEAD') {
        const resolved = await git(root, ['rev-parse', '--verify', '--symbolic-full-name', '--end-of-options', origin.label]);
        const name = line(resolved.stdout);
        if (resolved.code === 0 && (name.startsWith('refs/heads/') || name.startsWith('refs/remotes/'))) {
          target = await commit(root, name);
        }
      }
      base = head && target ? line(await run(root, ['merge-base', head, target])) : origin.hash;
      if (origin.label !== 'HEAD') baseLabel = origin.label;
    } else {
      if (head) throw new AppError('noBranchBase');
      base = await emptyTree();
    }
  } else if (mode === 'ref') {
    if (!ref) throw new AppError('referenceRequired');
    base = await commit(root, ref);
    baseLabel = ref;
  } else {
    throw new AppError('unknownDiffMode', { mode });
  }

  const tagsAt = async (revision: string) => (await run(root, ['tag', '--points-at', revision])).split('\n').filter(Boolean);
  const [baseTags, headTags, baseRefsOutput] = await Promise.all([
    baseIsEmpty ? [] : tagsAt(base),
    head ? tagsAt(head) : [],
    baseIsEmpty ? '' : run(root, ['for-each-ref', '--format=%(refname:short)', `--points-at=${base}`, 'refs/heads', 'refs/remotes']),
  ]);
  yield { type: 'metadata', root, branch, base, baseIsEmpty, baseLabel, baseRefs: baseRefsOutput.split('\n').filter(Boolean), baseTags, headTags };

  const uncommittedPaths = new Set(head ? (await run(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', head, '--'])).split('\0') : []);
  const raw = await run(root, ['diff', ...diffOptions, '--raw', '-z', base, '--']);
  const tokens = raw.split('\0');
  const withContextId = (file: DiffFile): DiffFile => {
    file.contextId = createHash('sha256')
      .update(JSON.stringify([base, file.path, file.oldPath, file.status, file.patch]))
      .digest('hex');
    return file;
  };
  const rawEntries: RawEntry[] = [];
  for (let i = 0; i < tokens.length && tokens[i];) {
    const header = tokens[i++];
    const match = /^:[0-7]+ [0-7]+ [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(header);
    if (!match || i >= tokens.length) throw new AppError('unexpectedRawDiff');
    const status = match[1];
    const firstPath = tokens[i++];
    const renamed = status === 'R' || status === 'C';
    const path = renamed ? tokens[i++] : firstPath;
    if (path === undefined) throw new AppError('incompleteRawDiff');
    rawEntries.push({ status, firstPath, path, renamed });
  }
  const trackedFile = async ({ status, firstPath, path, renamed }: RawEntry): Promise<DiffFile> => {
    const pathspecs = (renamed ? [firstPath, path] : [path]).map((name) => `:(literal)${name}`);
    const { stat, patch } = splitNumstatPatch(await run(root, ['diff', ...diffOptions, '-p', '--numstat', '-z', base, '--', ...pathspecs]));
    return withContextId({ path, ...(renamed ? { oldPath: firstPath } : {}), status, ...counts(stat), patch, contextId: '', uncommitted: !head || uncommittedPaths.has(path) || (renamed && uncommittedPaths.has(firstPath)) });
  };
  for await (const file of mapOrdered(rawEntries, FILE_CONCURRENCY, trackedFile)) yield { type: 'file', file };

  const untrackedFile = async (path: string): Promise<DiffFile | undefined> => {
    let linkTarget: string | undefined;
    try {
      const info = await lstat(join(root, path));
      // Nested repositories appear as directories; they have no file diff to show.
      if (info.isDirectory()) return undefined;
      if (info.isSymbolicLink()) linkTarget = await readlink(join(root, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (linkTarget !== undefined) {
      const lines = linkTarget.split('\n');
      if (linkTarget.endsWith('\n')) lines.pop();
      const quotedOld = JSON.stringify(`a/${path}`);
      const quotedNew = JSON.stringify(`b/${path}`);
      const patch = `diff --git ${quotedOld} ${quotedNew}\nnew file mode 120000\n--- /dev/null\n+++ ${quotedNew}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(value => `+${value}\n`).join('')}${linkTarget.endsWith('\n') ? '' : '\\ No newline at end of file\n'}`;
      return withContextId({ path, status: 'A', additions: lines.length, deletions: 0, binary: false, patch, contextId: '', uncommitted: true });
    }
    // Prefixing ./ prevents a filename beginning with '-' from being an option.
    const args = ['diff', '--no-index', '--no-ext-diff', '--no-textconv'];
    const combined = await git(root, [...args, '-p', '--numstat', '-z', '--', '/dev/null', `./${path}`]);
    if (combined.code > 1) {
      const error = combined.stderr.trim();
      throw error ? new Error(error) : new AppError('untrackedDiffFailed', { path });
    }
    const { stat, patch } = splitNumstatPatch(combined.stdout);
    return withContextId({ path, status: 'A', ...counts(stat), patch, contextId: '', uncommitted: true });
  };
  const untracked = await run(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  const untrackedPaths = untracked.split('\0').filter(Boolean);
  for await (const file of mapOrdered(untrackedPaths, FILE_CONCURRENCY, untrackedFile)) {
    if (file) yield { type: 'file', file };
  }
}

export async function getDiff(root: string, mode: Mode, ref?: string): Promise<DiffResult> {
  let metadata: Omit<DiffResult, 'files'> | undefined;
  const files: DiffFile[] = [];
  for await (const event of streamDiff(root, mode, ref)) {
    if (event.type === 'metadata') {
      const { type: _, ...info } = event;
      metadata = info;
    } else {
      files.push(event.file);
    }
  }
  if (!metadata) throw new Error('Diff metadata missing');
  return { ...metadata, files };
}

/** Load full context only if the comparison still matches the displayed patch. */
export async function getDiffContext(root: string, mode: Mode, ref: string | undefined, path: string, id: string): Promise<string> {
  const before = await getDiff(root, mode, ref);
  const file = before.files.find(item => item.path === path);
  if (!file || file.contextId !== id) throw Object.assign(new Error('Diff changed while loading context'), { statusCode: 409 });

  let patch = '';
  let failure: unknown;
  try {
    const tracked = await git(before.root, ['ls-files', '--error-unmatch', '--', `:(literal)${path}`]);
    if (tracked.code === 0 || file.status !== 'A') {
      const paths = (file.oldPath ? [file.oldPath, file.path] : [file.path]).map(name => `:(literal)${name}`);
      patch = await run(before.root, ['diff', ...diffOptions, '--unified=1000000000', before.base, '--', ...paths]);
    } else {
      // An untracked addition has no omitted context: its patch already contains every line.
      patch = file.patch;
    }
    // A pure rename or mode-only change has no textual hunk, even with full
    // context. Its unchanged content is still available for expansion.
    if (!file.binary && (file.status === 'R' || file.status === 'M') && !/^@@ /m.test(patch)) {
      const content = await run(before.root, ['show', '--no-textconv', `${before.base}:${file.oldPath ?? file.path}`]);
      if (!content.includes('\0')) {
        const lines = content ? content.split('\n') : [];
        if (lines[lines.length - 1] === '') lines.pop();
        if (lines.length) patch += `\n@@ -1,${lines.length} +1,${lines.length} @@\n${lines.map(line => ` ${line}\n`).join('')}`;
      }
    }
  } catch (error) {
    failure = error;
  }

  const after = await getDiff(root, mode, ref);
  if (after.files.find(item => item.path === path)?.contextId !== id) throw Object.assign(new Error('Diff changed while loading context'), { statusCode: 409 });
  if (failure) throw failure;
  return patch;
}
