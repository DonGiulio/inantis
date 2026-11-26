import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server/server.js';
import { ReviewStore } from '../src/review/index.js';
import reviewNotifications from '../extensions/omp.mjs';

test('OMP is notified once per new published review message in its own session', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'review-omp-'));
  const home = join(temp, 'home');
  const root = join(temp, 'repo');
  await mkdir(home); await mkdir(root);
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const app = await createServer(root);
  const store = new ReviewStore(root);
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const state = await (await fetch(`${url}/api/review/unanswered`)).json() as { instance: string; root: string };
    const directory = join(home, '.agentic-change-reviewer', 'sessions');
    await mkdir(directory, { recursive: true });
    const prefix = createHash('sha256').update('my-session').digest('hex');
    await writeFile(join(directory, `${prefix}-server.json`), JSON.stringify({ ...state, root: await realpath(root), url }));
    await writeFile(join(directory, `${prefix}-second-server.json`), JSON.stringify({ ...state, root: await realpath(root), url }));
    const otherPrefix = createHash('sha256').update('another-session').digest('hex');
    await writeFile(join(directory, `${otherPrefix}-server.json`), JSON.stringify({ ...state, root: await realpath(root), url }));

    let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    let tick: (() => Promise<void>) | undefined;
    const messages: { content: string }[] = [];
    reviewNotifications({
      on: (_event: string, handler: typeof start) => { start = handler; },
      sendMessage: (message: { content: string }) => { messages.push(message); },
    });
    await start!({}, { agent: { kind: 'main' }, sessionManager: { getSessionId: () => 'my-session' }, setInterval: (fn: typeof tick) => { tick = fn; } });
    const thread = store.create({ path: '', line: null, side: 'new', body: 'Draft' });
    await tick!();
    assert.equal(messages.length, 0);
    store.publish(thread.id);
    await tick!();
    assert.equal(messages.length, 1);
    assert.match(messages[0].content, /published review feedback/i);
    await tick!();
    assert.equal(messages.length, 1);
    store.replyAsAgent(thread.id, 'Answer');
    await tick!();
    const reply = store.reply(thread.id, 'A follow-up');
    store.publish(reply.id);
    await tick!();
    assert.equal(messages.length, 2);
  } finally {
    store.dispose(); await app.close();
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
    await rm(temp, { recursive: true, force: true });
  }
});
