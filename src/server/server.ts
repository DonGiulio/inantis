import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDiff, getDiffContext, streamDiff } from '../git/index.js';
import { ReviewStore } from '../review/index.js';
import { AppError, errorMessage, resolveLocale, translate } from '../locales/index.js';
import { getCommentIgnoreStatus } from './comment-ignore.js';

const exec = promisify(execFile);
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '../web');

export async function createServer(root: string, commentsDir?: string) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  let store = new ReviewStore(root, commentsDir);
  const canonicalRoot = await realpath(root);
  const instance = randomUUID();
  const isReviewFile = (file: { path: string; oldPath?: string }) => {
    const path = relative(canonicalRoot, store.markdownPath()).split(sep).join('/');
    return file.path === path || file.oldPath === path;
  };
  const clients = new Set<ServerResponse>();
  const notify = () => { for (const client of clients) client.write('data: {"type":"change"}\n\n'); };
  let lastStatus: string | undefined;
  let lastReview = store.snapshot();
  let polling = false;
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const current = store.snapshot();
      if (current.value !== lastReview.value) {
        if (current.id !== lastReview.id) {
          const replacement = new ReviewStore(root, commentsDir);
          store.dispose();
          store = replacement;
        }
        lastReview = store.snapshot();
        notify();
      }
      // Include untracked file contents, not just their names or tracked patches.
      const currentDiff = await getDiff(root, 'working');
      currentDiff.files = currentDiff.files.filter(file => !isReviewFile(file));
      const value = JSON.stringify(currentDiff);
      if (lastStatus !== undefined && value !== lastStatus) notify();
      lastStatus = value;
    } catch { notify(); } finally { polling = false; }
  }, 1500);
  timer.unref();

  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) return reply.code(403).send({ error: translate(resolveLocale(request.headers['accept-language']), 'unauthorizedHost') });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (!origin || origin !== `http://${host}`) return reply.code(403).send({ error: translate(resolveLocale(request.headers['accept-language']), 'unauthorizedOrigin') });
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const e = error as Error & { statusCode?: number };
    reply.code(e.statusCode && e.statusCode < 500 ? e.statusCode : 400).send({ error: errorMessage(e, resolveLocale(request.headers['accept-language'])) });
  });
  app.get('/api/review/ignore-status', async () => getCommentIgnoreStatus(root, store.markdownPath()));
  app.get('/api/diff', async (request) => {
    const { mode = 'working', ref } = request.query as { mode?: string; ref?: string };
    if (!['working', 'upstream', 'branch', 'ref'].includes(mode)) throw new AppError('invalidComparison');
    const result = await getDiff(root, mode as 'working' | 'upstream' | 'branch' | 'ref', ref);
    result.files = result.files.filter(file => !isReviewFile(file));
    return result;
  });
  app.get('/api/diff/stream', async (request, reply) => {
    const { mode = 'working', ref } = request.query as { mode?: string; ref?: string };
    if (!['working', 'upstream', 'branch', 'ref'].includes(mode)) throw new AppError('invalidComparison');
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    try {
      for await (const event of streamDiff(root, mode as 'working' | 'upstream' | 'branch' | 'ref', ref)) {
        if (reply.raw.destroyed) break;
        if (event.type === 'file' && isReviewFile(event.file)) continue;
        if (!reply.raw.write(`${JSON.stringify(event)}\n`)) {
          await new Promise<void>(resolve => {
            const done = () => { reply.raw.off('drain', done); reply.raw.off('close', done); resolve(); };
            reply.raw.once('drain', done); reply.raw.once('close', done);
          });
        }
      }
    } catch (error) {
      if (!reply.raw.destroyed) reply.raw.write(`${JSON.stringify({ type: 'error', error: errorMessage(error, resolveLocale(request.headers['accept-language'])), ...(error instanceof AppError ? { code: error.key } : {}) })}\n`);
    } finally { reply.raw.end(); }
  });
  app.get('/api/diff/context', async request => {
    const { mode = 'working', ref, path, id } = request.query as { mode?: string; ref?: string; path?: string; id?: string };
    if (!['working', 'upstream', 'branch', 'ref'].includes(mode)) throw new AppError('invalidComparison');
    if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..') || path.split(/[\\/]/).includes('.git')) throw new AppError('invalidPath');
    if (!id || !/^[a-f0-9]{64}$/.test(id)) throw new AppError('invalidPath');
    return { patch: await getDiffContext(root, mode as 'working' | 'upstream' | 'branch' | 'ref', ref, path, id) };
  });
  app.get('/api/search', async request => {
    const { q } = request.query as { q?: string };
    if (!q || q.includes('\n') || q.length > 512) throw new AppError('invalidSearch');
    let output: string;
    try {
      ({ stdout: output } = await exec('git', ['grep', '--untracked', '--exclude-standard', '-I', '-n', '-z', '-F', '-e', q, '--', '.'], { cwd: root, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 1) return { matches: [] };
      throw error;
    }
    const matches: { path: string; line: number; text: string }[] = [];
    let offset = 0;
    while (offset < output.length && matches.length < 500) {
      const pathEnd = output.indexOf('\0', offset);
      const lineEnd = output.indexOf('\0', pathEnd + 1);
      const textEnd = output.indexOf('\n', lineEnd + 1);
      if (pathEnd < 0 || lineEnd < 0 || textEnd < 0) break;
      matches.push({ path: output.slice(offset, pathEnd), line: Number(output.slice(pathEnd + 1, lineEnd)), text: output.slice(lineEnd + 1, textEnd) });
      offset = textEnd + 1;
    }
    return { matches };
  });
  app.get('/api/file', async (request) => {
    const { path } = request.query as { path?: string };
    if (!path || isAbsolute(path)) throw new AppError('invalidPath');
    const target = await realpath(resolve(root, path));
    const rel = relative(await realpath(root), target);
    if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel) || rel.split(/[\\/]/).includes('.git')) throw new AppError('outsideRepository');
    return { content: await readFile(target, 'utf8') };
  });
  app.get('/api/threads', async () => store.list());
  app.get('/api/review/unanswered', async () => ({ instance, root: canonicalRoot, threads: store.unanswered() }));
  app.post('/api/threads', async request => { const result = store.create(request.body as Parameters<typeof store.create>[0], resolveLocale(request.headers['accept-language'])); notify(); return result; });
  app.post('/api/threads/:id/replies', async request => { const { id } = request.params as { id: string }; const { body, published } = request.body as { body: string; published?: boolean }; const result = store.reply(id, body, resolveLocale(request.headers['accept-language']), published); notify(); return result; });
  app.patch('/api/threads/:id/messages/:messageId', async request => { const { id, messageId } = request.params as { id: string; messageId: string }; const { body } = request.body as { body: string }; const result = store.edit(id, messageId, body, resolveLocale(request.headers['accept-language'])); notify(); return result; });
  app.delete('/api/threads/:id/messages/:messageId', async request => { const { id, messageId } = request.params as { id: string; messageId: string }; store.remove(id, messageId, resolveLocale(request.headers['accept-language'])); notify(); return { ok: true }; });
  app.post('/api/threads/:id/messages/:messageId/publish', async request => { const { id, messageId } = request.params as { id: string; messageId: string }; const result = store.publishMessage(id, messageId, resolveLocale(request.headers['accept-language'])); notify(); return result; });
  app.post('/api/threads/:id/publish', async request => { const { id } = request.params as { id: string }; const result = store.publish(id, resolveLocale(request.headers['accept-language'])); notify(); return result; });
  app.post('/api/review/publish', async request => { const result = store.publishAll(resolveLocale(request.headers['accept-language'])); notify(); return result; });
  app.post('/api/threads/:id/resolve', async request => { const { id } = request.params as { id: string }; const { resolved } = request.body as { resolved: boolean }; const result = store.resolve(id, resolved, resolveLocale(request.headers['accept-language'])); notify(); return result; });
  app.post('/api/close', async request => { const { keep } = request.body as { keep: boolean }; if (typeof keep !== 'boolean') throw new AppError('invalidChoice'); store.close(keep); store = new ReviewStore(root, commentsDir); lastReview = store.snapshot(); notify(); return { ok: true }; });
  app.get('/api/events', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    reply.raw.write(': connected\n\n');
    clients.add(reply.raw);
    request.raw.on('close', () => clients.delete(reply.raw));
  });
  app.addHook('preClose', async () => { clearInterval(timer); for (const client of clients) client.end(); });
  app.addHook('onClose', async () => { store.dispose(); });
  await app.register(fastifyStatic, { root: webDir, prefix: '/' });
  app.get('/', async (_req, reply) => reply.sendFile('index.html'));
  return app;
}
