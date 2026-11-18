#!/usr/bin/env node
import open from 'open';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { repoRoot } from '../git/index.js';
import { createServer } from './server.js';
import { ReviewStore } from '../review/index.js';
import { errorMessage, systemLocale, translate } from '../locales/index.js';

const locale = systemLocale();
const args = process.argv.slice(2);
let commentsDir: string | undefined;
if (args[0] === '--comments-dir') {
  args.shift();
  commentsDir = args.shift();
  if (!commentsDir || commentsDir.startsWith('--')) {
    console.error('--comments-dir requires a path');
    process.exit(1);
  }
}

try {
  const root = await repoRoot(process.cwd());
  if (args[0] === 'comments') {
    const store = new ReviewStore(root, commentsDir);
    try {
      if (args.length === 4 && args[1] === 'list' && args.includes('--unanswered') && args.includes('--json')) {
        console.log(JSON.stringify(store.unanswered()));
      } else if (args.length === 3 && args[1] === 'watch' && args[2] === '--json') {
        const reviewId = store.snapshot().id;
        console.error('Watching for published review feedback');
        while (true) {
          if (store.snapshot().id !== reviewId) throw new Error('Review changed or closed while waiting for feedback');
          const unanswered = store.unanswered();
          if (unanswered.length) {
            console.log(JSON.stringify(unanswered));
            break;
          }
          await sleep(1000);
        }
      } else if (args[1] === 'create') {
        const { values } = parseArgs({
          args: args.slice(2),
          options: {
            general: { type: 'boolean' }, path: { type: 'string' }, line: { type: 'string' },
            'start-line': { type: 'string' }, side: { type: 'string' }, message: { type: 'string' },
          },
        });
        if (!values.message?.trim()) throw new Error('--message is required');
        const number = (value: string | undefined): number | undefined => {
          if (value === undefined) return undefined;
          if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Line numbers must be positive integers');
          return Number(value);
        };
        const line = number(values.line), startLine = number(values['start-line']);
        if (values.general) {
          if (values.path !== undefined || line !== undefined || startLine !== undefined || values.side !== undefined) throw new Error('--general cannot be combined with a file location');
          console.log(JSON.stringify(store.createAsAgent({ path: '', line: null, side: 'new', body: values.message }, locale)));
        } else {
          const path = values.path;
          if (!path || isAbsolute(path) || path.split(/[\\/]/).some(part => part === '..' || part === '.git')) throw new Error('A valid repository-relative --path is required');
          if (line === undefined) throw new Error('--line is required for a file comment');
          const side = values.side ?? 'new';
          if (side !== 'old' && side !== 'new') throw new Error('--side must be old or new');
          console.log(JSON.stringify(store.createAsAgent({ path, line, startLine, side, body: values.message }, locale)));
        }
      } else if (args.length === 5 && args[1] === 'reply' && args[3] === '--message') {
        const thread = store.replyAsAgent(args[2], args[4], locale);
        console.log(JSON.stringify({ ...thread, messages: thread.messages.filter(message => message.published) }));
      } else {
        throw new Error('Usage: comments list --unanswered --json | comments watch --json | comments create (--general | --path <file> --line <number> [--start-line <number>] [--side old|new]) --message <text> | comments reply <thread-id> --message <text>');
      }
    } finally { store.dispose(); }
  } else {
    if (args.some(arg => arg !== '--dev' && arg !== '--tour') || new Set(args).size !== args.length) throw new Error('Usage: inantis [--comments-dir <path>] [--dev] [--tour] [comments list|watch|create|reply ...]');
    const development = args.includes('--dev');
    const app = await createServer(root, commentsDir);
    let marker: string | undefined;
    app.addHook('onClose', async () => {
      if (marker) await unlink(marker).catch(error => { if (error.code !== 'ENOENT') throw error; });
    });
    const url = await app.listen({ host: '127.0.0.1', port: development ? 43883 : 0 });
    if (process.env.PI_SESSION_ID) {
      try {
        const response = await app.inject({ method: 'GET', url: '/api/review/unanswered' });
        if (response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode}`);
        const data = response.json() as { instance: string; root: string };
        const directory = join(homedir(), '.agentic-change-reviewer', 'sessions');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const prefix = createHash('sha256').update(process.env.PI_SESSION_ID).digest('hex');
        marker = join(directory, `${prefix}-${randomUUID()}.json`);
        await writeFile(marker, JSON.stringify({ instance: data.instance, root: data.root, url, commentsDir }), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        marker = undefined;
        console.error(`Cannot enable OMP feedback notifications: ${errorMessage(error, locale)}`);
      }
    }
    const launchUrl = args.includes('--tour') ? `${url}/?tour=1` : url;
    console.log(translate(locale, 'cliStarted', { url: launchUrl, root }));
    if (!development) {
      try { await open(launchUrl); } catch (error) { console.error(translate(locale, 'cliBrowserFailed', { error: String(error) })); }
    }
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
} catch (error) {
  console.error(errorMessage(error, locale));
  process.exitCode = 1;
}
