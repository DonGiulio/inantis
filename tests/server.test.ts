import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from '../src/server/server.js';
import { registerLocale } from '../src/locales/index.js';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import viteConfig from '../vite.config.js';

test('serves the diff and protects changes from external origins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-test-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  await writeFile(join(root, 'a.txt'), 'before\n'); git('add', '.'); git('commit', '-m', 'initial');
  await writeFile(join(root, 'a.txt'), 'after\n');
  const app = await createServer(root);
  registerLocale('zz', { invalidSearch: 'Localized search error', reviewTitle: 'Localized review {id}', side: 'Localized side' });
  try {
    const diff = await app.inject({ method: 'GET', url: '/api/diff?mode=working' });
    assert.equal(diff.statusCode, 200);
    assert.equal(diff.json().files[0].path, 'a.txt');
    const search = await app.inject({ method: 'GET', url: '/api/search?q=after' });
    assert.deepEqual(search.json().matches, [{ path: 'a.txt', line: 1, text: 'after' }]);
    const invalidSearch = await app.inject({ method: 'GET', url: '/api/search', headers: { 'accept-language': 'zz' } });
    assert.equal(invalidSearch.json().error, 'Localized search error');
    const blocked = await app.inject({ method: 'POST', url: '/api/threads', headers: { origin: 'https://example.com' }, payload: { path: 'a.txt', line: 1, side: 'new', body: 'hello' } });
    assert.equal(blocked.statusCode, 403);
    const headers = { origin: 'http://localhost:80' };
    const created = await app.inject({ method: 'POST', url: '/api/threads', headers, payload: { path: 'a.txt', line: 1, side: 'new', body: 'Review feedback' } });
    const beforePublication = await app.inject({ method: 'GET', url: '/api/review/unanswered' });
    assert.deepEqual(beforePublication.json().threads, []);
    assert.equal(created.statusCode, 200);
    const published = await app.inject({ method: 'POST', url: `/api/threads/${created.json().id}/publish`, headers: { ...headers, 'accept-language': 'zz' } });
    assert.equal(published.statusCode, 200);
    const pending = await app.inject({ method: 'GET', url: '/api/review/unanswered' });
    assert.equal(pending.json().instance, beforePublication.json().instance);
    assert.equal(pending.json().threads[0].id, created.json().id);
    assert.equal(pending.json().threads[0].messages[0].body, 'Review feedback');
    const directory = join(root, '.agentic-change-reviewer');
    const markdown = (await readdir(directory)).find(name => name.startsWith('.agentic-review-') && name.endsWith('.md'));
    assert.ok(markdown);
    assert.match(await readFile(join(directory, markdown), 'utf8'), /Review feedback/);
    assert.match(await readFile(join(directory, markdown), 'utf8'), /^# Localized review /);
    await writeFile(join(directory, 'notes.md'), 'ordinary project file\n');
    const updatedDiff = await app.inject({ method: 'GET', url: '/api/diff?mode=working' });
    const paths = updatedDiff.json().files.map((file: { path: string }) => file.path);
    assert.ok(paths.includes('.agentic-change-reviewer/notes.md'));
    assert.ok(!paths.includes(`.agentic-change-reviewer/${markdown}`));
    const stream = await app.inject({ method: 'GET', url: '/api/diff/stream?mode=working' });
    const streamed = stream.body.trim().split('\n').map(record => JSON.parse(record));
    assert.ok(streamed.some(event => event.type === 'file' && event.file.path === '.agentic-change-reviewer/notes.md'));
    assert.ok(!streamed.some(event => event.type === 'file' && event.file.path === `.agentic-change-reviewer/${markdown}`));
  } finally { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('validates comparison, file and search inputs and handles empty results', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'review-input-validation-'));
  const root = join(parent, 'repo');
  await mkdir(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  await writeFile(join(root, 'source.txt'), 'needle\nother line\n');
  git('add', '.'); git('commit', '-m', 'initial');
  const sibling = join(parent, 'outside-review-file.txt');
  await writeFile(sibling, 'outside');
  const app = await createServer(root);
  try {
    const foreignHost = await app.inject({ method: 'GET', url: '/api/review/unanswered', headers: { host: 'example.com' } });
    assert.equal(foreignHost.statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/threads', payload: {} })).statusCode, 403);
    assert.notEqual((await app.inject({ method: 'OPTIONS', url: '/api/review/unanswered' })).statusCode, 403);
    assert.equal((await app.inject('/api/diff?mode=invalid')).statusCode, 400);
    assert.equal((await app.inject('/api/diff/stream?mode=invalid')).statusCode, 400);
    const streamError = await app.inject('/api/diff/stream?mode=ref&ref=missing-ref');
    const event = JSON.parse(streamError.body.trim());
    assert.equal(event.type, 'error');
    assert.ok(event.error);
    assert.equal((await app.inject('/api/diff/context?mode=invalid&path=source.txt&id=' + 'a'.repeat(64))).statusCode, 400);
    assert.equal((await app.inject('/api/diff/context?path=.git/config&id=' + 'a'.repeat(64))).statusCode, 400);
    assert.equal((await app.inject('/api/diff/context?path=source.txt&id=bad')).statusCode, 400);
    assert.equal((await app.inject('/api/diff/context?path=missing.txt&id=' + 'a'.repeat(64))).statusCode, 409);
    assert.deepEqual((await app.inject('/api/search?q=not-found')).json(), { matches: [] });
    await writeFile(join(root, 'many-matches.txt'), `${Array.from({ length: 505 }, (_, index) => `needle ${index}`).join('\n')}\n`);
    assert.equal((await app.inject('/api/search?q=needle')).json().matches.length, 500);
    assert.equal((await app.inject('/api/search?q=line%0Abreak')).statusCode, 400);
    assert.equal((await app.inject(`/api/search?q=${'x'.repeat(513)}`)).statusCode, 400);
    assert.deepEqual((await app.inject('/api/file?path=source.txt')).json(), { content: 'needle\nother line\n' });
    assert.equal((await app.inject('/api/file?path=.git/config')).statusCode, 400);
    assert.equal((await app.inject('/api/file?path=missing.txt')).statusCode, 400);
    assert.equal((await app.inject('/api/file?path=../outside-review-file.txt')).statusCode, 400);
  } finally {
    await app.close();
    await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('closes and recreates reviews through the API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-close-api-'));
  const app = await createServer(root);
  try {
    const headers = { origin: 'http://localhost:80' };
    assert.equal((await app.inject({ method: 'POST', url: '/api/close', headers, payload: { keep: 'yes' } })).statusCode, 400);
    const created = await app.inject({ method: 'POST', url: '/api/threads', headers: { origin: 'http://localhost:80' }, payload: { path: '', line: null, side: 'new', body: 'question', published: true } });
    assert.equal(created.statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/close', headers, payload: { keep: true } })).statusCode, 200);
    assert.deepEqual((await app.inject('/api/threads')).json(), []);
    assert.ok((await readdir(join(root, '.agentic-change-reviewer'))).some(name => name.endsWith('.md')));
    assert.equal((await app.inject({ method: 'POST', url: '/api/close', headers, payload: { keep: false } })).statusCode, 200);
    assert.deepEqual((await app.inject('/api/threads')).json(), []);
    assert.deepEqual((await app.inject('/api/review/unanswered')).json().threads, []);
  } finally { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('development proxy saves drafts and rejects external origins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-proxy-test-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  await writeFile(join(root, 'a.txt'), 'content\n'); git('add', '.'); git('commit', '-m', 'initial');
  const app = await createServer(root);
  let vite: ViteDevServer | undefined;
  try {
    const target = await app.listen({ host: '127.0.0.1', port: 0 });
    const proxy = viteConfig.server!.proxy!['/api'];
    vite = await createViteServer({
      configFile: false,
      cacheDir: join(root, '.vite'),
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        host: '127.0.0.1',
        port: 0,
        proxy: { '/api': typeof proxy === 'string' ? target : { ...proxy, target } },
      },
    });
    await vite.listen();
    const address = vite.httpServer!.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({ path: 'a.txt', line: 1, side: 'new', body: 'Draft through Vite' });
    const blocked = await fetch(`${url}/api/threads`, {
      method: 'POST',
      headers: { origin: 'https://example.com', 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(blocked.status, 403);
    const response = await fetch(`${url}/api/threads`, {
      method: 'POST',
      headers: { origin: url, 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(response.status, 200);
    const threads = await (await fetch(`${url}/api/threads`)).json();
    assert.ok(threads.some((thread: { messages: { body: string }[] }) =>
      thread.messages.some(message => message.body === 'Draft through Vite')));
  } finally {
    await vite?.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('immediate messages leave review drafts editable until the whole review is published', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-publish-test-'));
  const app = await createServer(root);
  try {
    const headers = { origin: 'http://localhost:80' };
    const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, headers, payload });
    const first = (await post('/api/threads', { path: '', line: null, side: 'new', body: 'Draft one' })).json();
    const second = (await post('/api/threads', { path: '', line: null, side: 'new', body: 'Draft two' })).json();
    const edit = await app.inject({ method: 'PATCH', url: `/api/threads/${first.id}/messages/${first.messages[0].id}`, headers, payload: { body: 'Edited draft' } });
    assert.equal(edit.statusCode, 200);
    const sent = await post(`/api/threads/${first.id}/replies`, { body: 'Send now', published: true });
    assert.equal(sent.statusCode, 200);
    assert.deepEqual(sent.json().messages.map((m: { published: boolean }) => m.published), [false, true]);
    const immediate = await post('/api/threads', { path: '', line: null, side: 'new', body: 'Immediate thread', published: true });
    assert.equal(immediate.json().messages[0].published, true);
    const pending = (await app.inject({ method: 'GET', url: '/api/review/unanswered' })).json().threads;
    assert.deepEqual(pending.find((t: { id: string }) => t.id === first.id).messages.map((m: { body: string }) => m.body), ['Send now']);
    assert.ok(!pending.some((t: { id: string }) => t.id === second.id));
    assert.equal((await post('/api/review/publish')).statusCode, 200);
    const threads = (await app.inject({ method: 'GET', url: '/api/threads' })).json();
    assert.ok(threads.every((t: { messages: { published: boolean }[] }) => t.messages.every(m => m.published)));
    assert.equal(threads.find((t: { id: string }) => t.id === first.id).messages[0].body, 'Edited draft');
    const immutable = await app.inject({ method: 'PATCH', url: `/api/threads/${first.id}/messages/${first.messages[0].id}`, headers, payload: { body: 'Too late' } });
    assert.notEqual(immutable.statusCode, 200);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('publishes one selected draft without exposing other drafts in the discussion or review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-send-one-'));
  const app = await createServer(root);
  const headers = { origin: 'http://localhost:80' };
  try {
    const create = async (body: string) => (await app.inject({ method: 'POST', url: '/api/threads', headers, payload: { path: '', line: null, side: 'new', body } })).json();
    const first = await create('First draft');
    const second = await create('Other discussion draft');
    const reply = await app.inject({ method: 'POST', url: `/api/threads/${first.id}/replies`, headers, payload: { body: 'Reply draft' } });
    const replyId = reply.json().messages[1].id;
    const sent = await app.inject({ method: 'POST', url: `/api/threads/${first.id}/messages/${first.messages[0].id}/publish`, headers });
    assert.equal(sent.statusCode, 200);
    const threads = (await app.inject({ method: 'GET', url: '/api/threads' })).json();
    assert.deepEqual(threads.find((thread: { id: string }) => thread.id === first.id).messages.map((message: { published: boolean }) => message.published), [true, false]);
    assert.equal(threads.find((thread: { id: string }) => thread.id === second.id).messages[0].published, false);
    const markdown = await readFile(join(root, '.agentic-change-reviewer', (await readdir(join(root, '.agentic-change-reviewer')))[0]), 'utf8');
    assert.match(markdown, /First draft/);
    assert.doesNotMatch(markdown, /Reply draft|Other discussion draft/);
    const replySent = await app.inject({ method: 'POST', url: `/api/threads/${first.id}/messages/${replyId}/publish`, headers });
    assert.equal(replySent.statusCode, 200);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/review/unanswered' })).json().threads[0].messages.map((message: { body: string }) => message.body), ['First draft', 'Reply draft']);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
