import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ReviewStore } from '../src/review/index.js';
import { createServer } from '../src/server/server.js';

test('agent replies publish without leaking reviewer drafts and clear unanswered status', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-protocol-'));
  const store = new ReviewStore(root);
  try {
    const thread = store.create({ path: '', line: null, side: 'new', body: 'Published question' });
    store.publish(thread.id);
    store.reply(thread.id, 'private draft');
    const pending = store.unanswered();
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0].messages.map(m => m.body), ['Published question']);
    store.replyAsAgent(thread.id, 'Agent response');
    assert.deepEqual(store.unanswered(), []);
    const messages = store.list()[0].messages;
    assert.deepEqual(messages.map(m => [m.author, m.published]), [['reviewer', true], ['reviewer', false], ['agent', true]]);
    const directory = join(root, '.agentic-change-reviewer');
    const markdown = readFileSync(join(directory, readdirSync(directory)[0]), 'utf8');
    assert.match(markdown, /Published question/);
    assert.match(markdown, /Agent response/);
    assert.match(markdown, /Agent/);
    assert.doesNotMatch(markdown, /private draft/);
    assert.doesNotMatch(markdown, /## ""/);
    store.publish(thread.id);
    assert.equal(store.unanswered().length, 1);
    assert.deepEqual(store.unanswered()[0].messages.map(m => m.body), ['Published question', 'private draft', 'Agent response']);
    store.replyAsAgent(thread.id, 'Second response');
    assert.throws(() => store.edit(thread.id, thread.messages[0].id, 'Revised question'), /published/i);
    assert.equal(store.unanswered().length, 0);
  } finally { store.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('published reviewer and agent messages cannot be edited or deleted, but drafts can', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-immutable-'));
  const store = new ReviewStore(root);
  try {
    const thread = store.create({ path: '', line: null, side: 'new', body: 'Question' });
    store.publish(thread.id);
    store.replyAsAgent(thread.id, 'Answer');
    const published = store.list()[0].messages;
    for (const message of published) {
      assert.throws(() => store.edit(thread.id, message.id, 'changed'), /published/i);
      assert.throws(() => store.remove(thread.id, message.id), /published/i);
    }
    const draft = store.reply(thread.id, 'draft').messages.at(-1)!;
    store.edit(thread.id, draft.id, 'changed draft');
    assert.equal(store.list()[0].messages.at(-1)?.body, 'changed draft');
    store.remove(thread.id, draft.id);
    assert.deepEqual(store.list()[0].messages.map(message => message.body), ['Question', 'Answer']);
  } finally { store.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('removing the last draft deletes its thread and unpublished threads cannot receive agent replies', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-empty-thread-'));
  const store = new ReviewStore(root);
  try {
    const thread = store.create({ path: '', line: null, side: 'new', body: 'draft' });
    assert.throws(() => store.replyAsAgent(thread.id, 'answer'), /published messages/i);
    assert.throws(() => store.remove(thread.id, 'missing-message'), /Message not found/i);
    store.remove(thread.id, thread.messages[0].id);
    assert.deepEqual(store.list(), []);
    assert.throws(() => store.remove(thread.id, thread.messages[0].id), /Thread not found/i);
  } finally { store.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('a custom external comments directory is shared and protects changed Markdown', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-protocol-root-'));
  const directory = mkdtempSync(join(tmpdir(), 'review-protocol-output-'));
  const first = new ReviewStore(root, directory);
  const second = new ReviewStore(root, directory);
  try {
    const thread = first.create({ path: 'code.ts', line: 1, side: 'new', body: 'question' });
    first.publish(thread.id);
    second.replyAsAgent(thread.id, 'answer');
    assert.equal(first.list()[0].messages[1].author, 'agent');
    const file = join(directory, readdirSync(directory)[0]);
    writeFileSync(file, 'external content');
    assert.throws(() => first.replyAsAgent(thread.id, 'another answer'));
    assert.equal(readFileSync(file, 'utf8'), 'external content');
  } finally { first.dispose(); second.dispose(); rmSync(root, { recursive: true, force: true }); rmSync(directory, { recursive: true, force: true }); }
});

test('legacy messages and published root Markdown remain usable', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-protocol-legacy-'));
  let store = new ReviewStore(root);
  try {
    const thread = store.create({ path: '', line: null, side: 'new', body: 'legacy question' });
    store.publish(thread.id);
    const original = store.markdownPath();
    const legacy = join(realpathSync(root), basename(original));
    renameSync(original, legacy);
    store.dispose();
    const key = createHash('sha256').update(realpathSync(root)).digest('hex');
    const db = new DatabaseSync(join(homedir(), '.agentic-change-reviewer', `${key}.sqlite`));
    try {
      const row = db.prepare('SELECT threads FROM review WHERE singleton = 1').get() as { threads: string };
      const threads = JSON.parse(row.threads);
      delete threads[0].messages[0].author;
      delete threads[0].messages[0].publishedOrder;
      db.prepare('UPDATE review SET threads = ?, markdown_path = NULL WHERE singleton = 1').run(JSON.stringify(threads));
    } finally { db.close(); }
    store = new ReviewStore(root);
    assert.equal(store.unanswered()[0].messages[0].author, 'reviewer');
    store.replyAsAgent(thread.id, 'legacy answer');
    assert.match(readFileSync(legacy, 'utf8'), /legacy answer/);
    assert.equal(store.markdownPath(), legacy);
  } finally { store.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('a replaced output directory cannot redirect deletion through a symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-protocol-symlink-'));
  const outside = mkdtempSync(join(tmpdir(), 'review-protocol-outside-'));
  const store = new ReviewStore(root);
  try {
    const thread = store.create({ path: '', line: null, side: 'new', body: 'question' });
    store.publish(thread.id);
    const file = store.markdownPath();
    const contents = readFileSync(file, 'utf8');
    const directory = join(root, '.agentic-change-reviewer');
    renameSync(directory, `${directory}-original`);
    writeFileSync(join(outside, basename(file)), contents);
    symlinkSync(outside, directory);
    assert.throws(() => store.close(false));
    assert.equal(readFileSync(join(outside, basename(file)), 'utf8'), contents);
  } finally { store.dispose(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('CLI lists published context and writes agent replies without exposing drafts', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-protocol-cli-'));
  const directory = mkdtempSync(join(tmpdir(), 'review-protocol-cli-output-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  const store = new ReviewStore(root, directory);
  const cli = fileURLToPath(new URL('../src/server/cli.ts', import.meta.url));
  const run = (...args: string[]) => execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, '--comments-dir', directory, ...args], { cwd: root, encoding: 'utf8' });
  try {
    const thread = store.create({ path: '', line: null, side: 'new', body: 'question' });
    store.publish(thread.id);
    store.reply(thread.id, 'private draft');
    const pending = JSON.parse(run('comments', 'list', '--unanswered', '--json'));
    assert.deepEqual(pending[0].messages.map((m: { body: string }) => m.body), ['question']);
    const reply = JSON.parse(run('comments', 'reply', thread.id, '--message', 'answer'));
    assert.deepEqual(reply.messages.map((m: { body: string }) => m.body), ['question', 'answer']);
    assert.equal(reply.messages[1].author, 'agent');
    assert.deepEqual(JSON.parse(run('comments', 'list', '--unanswered', '--json')), []);
    assert.throws(() => run('comments', 'reply', 'missing', '--message', 'answer'));
  } finally { store.dispose(); rmSync(root, { recursive: true, force: true }); rmSync(directory, { recursive: true, force: true }); }
});

test('CLI creates agent findings on a line and as general discussions', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-findings-'));
  const directory = mkdtempSync(join(tmpdir(), 'review-findings-output-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, 'code.ts'), 'first\nsecond\nthird\n');
  const store = new ReviewStore(root, directory);
  const cli = fileURLToPath(new URL('../src/server/cli.ts', import.meta.url));
  const run = (...args: string[]) => execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, '--comments-dir', directory, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const finding = JSON.parse(run('comments', 'create', '--path', 'code.ts', '--start-line', '2', '--line', '3', '--side', 'new', '--message', 'Potential bug'));
    assert.equal(finding.path, 'code.ts');
    assert.equal(finding.startLine, 2);
    assert.equal(finding.line, 3);
    assert.deepEqual(finding.messages.map((m: { author: string; body: string; published: boolean }) => [m.author, m.body, m.published]), [['agent', 'Potential bug', true]]);
    assert.equal(finding.stale, false);
    const general = JSON.parse(run('comments', 'create', '--general', '--message', 'Overall concern'));
    assert.equal(general.path, '');
    assert.equal(general.line, null);
    assert.equal(general.messages[0].author, 'agent');
    assert.deepEqual(store.unanswered(), []);
    store.reply(finding.id, 'Can you clarify?');
    store.publish(finding.id);
    assert.equal(store.unanswered()[0].id, finding.id);
    const markdown = readFileSync(store.markdownPath(), 'utf8');
    assert.match(markdown, /Potential bug/);
    assert.match(markdown, /Overall concern/);
    assert.throws(() => run('comments', 'create', '--path', 'code.ts', '--line', 'nope', '--message', 'bad'));
    assert.throws(() => run('comments', 'create', '--path', 'code.ts', '--line', '9007199254740992', '--message', 'bad'));
    assert.throws(() => run('comments', 'create', '--message', 'missing path'));
    assert.throws(() => run('comments', 'create', '--path', 'code.ts', '--message', 'missing line'));
    assert.throws(() => run('comments', 'create', '--path', 'code.ts', '--line', '1', '--side', 'middle', '--message', 'bad side'));
    assert.throws(() => run('comments', 'create', '--path', join(root, 'code.ts'), '--line', '1', '--message', 'absolute path'));
    assert.throws(() => run('comments', 'create', '--path', '../outside.ts', '--line', '1', '--message', 'traversal'));
    assert.throws(() => run('comments', 'create', '--path', '.git/config', '--line', '1', '--message', 'git metadata'));
    assert.throws(() => run('comments', 'create', '--general', '--path', 'code.ts', '--message', 'bad'));
    assert.throws(() => run('comments', 'list'));
    assert.throws(() => run('unknown-command'));
  } finally { store.dispose(); rmSync(root, { recursive: true, force: true }); rmSync(directory, { recursive: true, force: true }); }
});

test('CLI watch wakes on a published reviewer message, excluding drafts', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-watch-'));
  const directory = mkdtempSync(join(tmpdir(), 'review-watch-output-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  const store = new ReviewStore(root, directory);
  const cli = fileURLToPath(new URL('../src/server/cli.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), cli, '--comments-dir', directory, 'comments', 'watch', '--json'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const ready = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.stderr.setEncoding('utf8').on('data', chunk => {
      errors += chunk;
      if (errors.includes('Watching for published review feedback')) resolve();
    });
  });
  try {
    await ready;
    const draft = store.create({ path: '', line: null, side: 'new', body: 'draft' });
    assert.equal(child.exitCode, null);
    const published = store.create({ path: '', line: null, side: 'new', body: 'question' });
    store.publish(published.id);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, errors);
    const result = JSON.parse(output);
    assert.deepEqual(result.map((thread: { id: string }) => thread.id), [published.id]);
    assert.ok(!output.includes(draft.id));
  } finally { child.kill(); store.dispose(); rmSync(root, { recursive: true, force: true }); rmSync(directory, { recursive: true, force: true }); }
});

test('SSE notifies a browser when another process publishes an agent reply', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-protocol-sse-'));
  const home = mkdtempSync(join(tmpdir(), 'review-protocol-home-'));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const commentsDir = join(home, 'comments');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'code.txt'), 'content');
  git('add', 'code.txt'); git('commit', '-m', 'initial');
  const store = new ReviewStore(root, commentsDir);
  const thread = store.create({ path: '', line: null, side: 'new', body: 'question' });
  store.publish(thread.id);
  const app = await createServer(root, commentsDir);
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let responseBody: ReadableStream<Uint8Array> | null = null;
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${url}/api/events`, { signal: abort.signal });
    assert.equal(response.status, 200);
    responseBody = response.body;
    reader = response.body!.getReader();
    await reader.read(); // initial connected comment
    const cli = fileURLToPath(new URL('../src/server/cli.ts', import.meta.url));
    await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), cli, '--comments-dir', commentsDir, 'comments', 'reply', thread.id, '--message', 'answer'], { cwd: root });
    const event = await reader.read();
    assert.match(new TextDecoder().decode(event.value), /\"type\":\"change\"/);
    const threads = await (await fetch(`${url}/api/threads`)).json();
    assert.equal(threads[0].messages[1].body, 'answer');
    assert.equal(threads[0].messages[1].author, 'agent');
  } finally {
    if (reader) await reader.cancel().catch(() => {});
    if (responseBody?.locked) await responseBody.cancel().catch(() => {});
    abort.abort();
    store.dispose();
    await app.close();
    reader?.releaseLock();
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    // Node on Windows may retain a process cwd briefly after the child exits;
    // the OS temp directory owns this disposable fixture and cleans it later.
    if (process.platform !== 'win32') rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
