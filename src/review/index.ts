import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { renderReview } from '../export/index.js';
import { AppAggregateError, AppError } from '../locales/index.js';

export interface Message {
  id: string;
  body: string;
  author: 'reviewer' | 'agent';
  published: boolean;
  publishedOrder?: number;
  createdAt: string;
}

export interface Thread {
  id: string;
  path: string;
  line: number | null;
  startLine?: number;
  side: 'old' | 'new';
  resolved: boolean;
  messages: Message[];
  stale?: boolean;
}

interface StoredThread extends Thread {
  anchor?: { fileHash: string; lineText: string; rangeText?: string[] } | null;
}

interface State {
  id: string;
  threads: StoredThread[];
  exported: string | null;
  markdownPath: string;
}

interface Row {
  id: string;
  threads: string;
  exported: string | null;
  markdown_path: string;
}

/** Persistent local review. Published Markdown is not an input to the store. */
export class ReviewStore {
  private readonly root: string;
  private readonly db: DatabaseSync;
  private readonly reviewId: string;
  private readonly outputPath: string;
  private closed = false;

  constructor(root: string, commentsDir?: string) {
    this.root = realpathSync(root);
    if (commentsDir !== undefined && !commentsDir.trim()) throw new Error('Comments directory must not be empty');
    const requested = resolve(this.root, commentsDir ?? '.agentic-change-reviewer');
    // Canonicalize the nearest existing ancestor so an explicitly chosen external
    // directory is supported without following a later replacement symlink.
    let ancestor = requested;
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error(`Invalid comments directory: ${requested}`);
      ancestor = parent;
    }
    if (!statSync(ancestor).isDirectory()) throw new Error(`Comments directory is not a directory: ${ancestor}`);
    const directory = resolve(realpathSync(ancestor), relative(ancestor, requested));
    const databaseDirectory = join(homedir(), '.agentic-change-reviewer');
    mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
    const key = createHash('sha256').update(this.root).digest('hex');
    this.db = new DatabaseSync(join(databaseDirectory, `${key}.sqlite`));
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
      this.db.exec('CREATE TABLE IF NOT EXISTS review (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), id TEXT NOT NULL, threads TEXT NOT NULL, exported TEXT, markdown_path TEXT)');
      const columns = this.db.prepare('PRAGMA table_info(review)').all() as unknown as { name: string }[];
      if (!columns.some(column => column.name === 'markdown_path')) this.db.exec('ALTER TABLE review ADD COLUMN markdown_path TEXT');
      const id = randomUUID();
      this.db.prepare('INSERT OR IGNORE INTO review (singleton, id, threads, exported, markdown_path) VALUES (1, ?, ?, NULL, ?)').run(id, '[]', join(directory, `.agentic-review-${id}.md`));
      const row = this.db.prepare('SELECT id, exported, markdown_path FROM review WHERE singleton = 1').get() as { id: string; exported: string | null; markdown_path: string | null };
      const legacy = join(this.root, `.agentic-review-${row.id}.md`);
      const path = row.markdown_path ?? (row.exported === null ? join(directory, `.agentic-review-${row.id}.md`) : legacy);
      if (row.markdown_path === null) this.db.prepare('UPDATE review SET markdown_path = ? WHERE singleton = 1').run(path);
      if (path !== legacy && dirname(path) !== directory) throw new Error(`Active review uses a different comments directory: ${dirname(path)}`);
      this.reviewId = row.id;
      this.outputPath = path;
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      this.db.close();
      throw error;
    }
  }
  markdownPath(): string {
    return this.outputPath;
  }


  list(): Thread[] {
    return this.load().threads.map((thread) => this.view(thread));
  }

  /** Snapshot persisted state, including changes made by another process. */
  snapshot(): { id: string | null; value: string } {
    this.assertOpen();
    const row = this.db.prepare('SELECT id, threads, exported, markdown_path FROM review WHERE singleton = 1').get() as unknown as Row | undefined;
    return { id: row?.id ?? null, value: JSON.stringify(row ?? null) };
  }

  /** Return published context only for threads with a reviewer awaiting an agent reply. */
  unanswered(): Thread[] {
    return this.list().flatMap(thread => {
      const messages = thread.messages.filter(message => message.published);
      const ordered = messages.map((message, index) => ({ message, order: message.publishedOrder ?? index + 1 }))
        .sort((a, b) => a.order - b.order);
      const pending = ordered.length > 0 && ordered[ordered.length - 1].message.author === 'reviewer';
      return pending ? [{ ...thread, messages }] : [];
    });
  }

  create(input: { path: string; line: number | null; startLine?: number; side: 'old' | 'new'; body: string; published?: boolean }, locale = 'en'): Thread {
    if (typeof input.path !== 'string' || (!input.path && input.line !== null)) throw new TypeError('Invalid path');
    if (input.side !== 'old' && input.side !== 'new') throw new TypeError('Invalid side');
    if (input.line !== null && (!Number.isSafeInteger(input.line) || input.line < 1)) throw new TypeError('Invalid line');
    if (input.startLine !== undefined && (input.line === null || !Number.isSafeInteger(input.startLine) || input.startLine < 1)) throw new TypeError('Invalid start line');
    const start = input.startLine === undefined ? input.line : Math.min(input.startLine, input.line!);
    const line = input.startLine === undefined ? input.line : Math.max(input.startLine, input.line!);
    return this.change((state) => {
      const thread: StoredThread = {
        id: randomUUID(), path: input.path, line, ...(start !== null && start !== line ? { startLine: start } : {}),
        side: input.side, resolved: false, messages: [this.message(input.body, 'reviewer', input.published === true)],
        anchor: input.side === 'new' && line !== null ? this.capture(input.path, line, start ?? line) : null,
      };
      if (thread.messages[0].published) thread.messages[0].publishedOrder = 1;
      state.threads.push(thread);
      return this.view(thread);
    }, locale);
  }

  createAsAgent(input: { path: string; line: number | null; startLine?: number; side: 'old' | 'new'; body: string }, locale = 'en'): Thread {
    if (typeof input.path !== 'string' || (!input.path && input.line !== null)) throw new TypeError('Invalid path');
    if (input.side !== 'old' && input.side !== 'new') throw new TypeError('Invalid side');
    if (input.line !== null && (!Number.isSafeInteger(input.line) || input.line < 1)) throw new TypeError('Invalid line');
    if (input.startLine !== undefined && (input.line === null || !Number.isSafeInteger(input.startLine) || input.startLine < 1)) throw new TypeError('Invalid start line');
    const start = input.startLine === undefined ? input.line : Math.min(input.startLine, input.line!);
    const line = input.startLine === undefined ? input.line : Math.max(input.startLine, input.line!);
    const anchor = input.side === 'new' && line !== null ? this.capture(input.path, line, start ?? line) : null;
    if (input.side === 'new' && line !== null && !anchor) throw new Error('Cannot anchor finding to the requested file and line range');
    return this.change(state => {
      const message = this.message(input.body, 'agent', true);
      message.publishedOrder = 1;
      const thread: StoredThread = {
        id: randomUUID(), path: input.path, line, ...(start !== null && start !== line ? { startLine: start } : {}),
        side: input.side, resolved: false, messages: [message], anchor,
      };
      state.threads.push(thread);
      return this.view(thread);
    }, locale);
  }

  reply(id: string, body: string, locale = 'en', published = false): Thread {
    return this.change((state) => {
      const thread = this.thread(state, id);
      const message = this.message(body, 'reviewer', published === true);
      if (message.published) message.publishedOrder = this.nextPublishedOrder(thread);
      thread.messages.push(message);
      return this.view(thread);
    }, locale);
  }

  replyAsAgent(id: string, body: string, locale = 'en'): Thread {
    return this.change(state => {
      const thread = this.thread(state, id);
      if (!thread.messages.some(message => message.published)) throw new AppError('threadNotPublished', { id });
      const message = this.message(body, 'agent', true);
      message.publishedOrder = this.nextPublishedOrder(thread);
      thread.messages.push(message);
      return this.view(thread);
    }, locale);
  }

  edit(id: string, messageId: string, body: string, locale = 'en'): Thread {
    return this.change((state) => {
      const thread = this.thread(state, id);
      const message = thread.messages.find((item) => item.id === messageId);
      if (!message) throw new AppError('messageNotFound', { id: messageId });
      if (message.published) throw new AppError('publishedMessageImmutable');
      if (typeof body !== 'string' || !body.trim()) throw new AppError('invalidMessage');
      message.body = body;
      return this.view(thread);
    }, locale);
  }

  private nextPublishedOrder(thread: StoredThread): number {
    return thread.messages.reduce((max, message, index) => message.published ? Math.max(max, message.publishedOrder ?? index + 1) : max, 0) + 1;
  }

  remove(id: string, messageId: string, locale = 'en'): void {
    this.change((state) => {
      const thread = this.thread(state, id);
      const index = thread.messages.findIndex((item) => item.id === messageId);
      if (index < 0) throw new AppError('messageNotFound', { id: messageId });
      if (thread.messages[index].published) throw new AppError('publishedMessageImmutable');
      thread.messages.splice(index, 1);
      if (thread.messages.length === 0) state.threads.splice(state.threads.indexOf(thread), 1);
    }, locale);
  }

  publishMessage(id: string, messageId: string, locale = 'en'): Thread {
    return this.change((state) => {
      const thread = this.thread(state, id);
      const message = thread.messages.find(item => item.id === messageId);
      if (!message) throw new AppError('messageNotFound', { id: messageId });
      if (!message.published) {
        message.publishedOrder = this.nextPublishedOrder(thread);
        message.published = true;
      }
      return this.view(thread);
    }, locale);
  }

  publish(id: string, locale = 'en'): Thread {
    return this.change((state) => {
      const thread = this.thread(state, id);
      let order = this.nextPublishedOrder(thread);
      for (const message of thread.messages) {
        if (!message.published) {
          message.published = true;
          message.publishedOrder = order++;
        }
      }
      return this.view(thread);
    }, locale);
  }

  publishAll(locale = 'en'): Thread[] {
    return this.change((state) => {
      for (const thread of state.threads) {
        let order = this.nextPublishedOrder(thread);
        for (const message of thread.messages) {
          if (!message.published) {
            message.published = true;
            message.publishedOrder = order++;
          }
        }
      }
      return state.threads.map(thread => this.view(thread));
    }, locale);
  }

  resolve(id: string, resolved: boolean, locale = 'en'): Thread {
    return this.change((state) => {
      const thread = this.thread(state, id);
      thread.resolved = resolved;
      return this.view(thread);
    }, locale);
  }

  close(keep: boolean): void {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    let previous: string | null = null;
    let removed = false;
    try {
      const state = this.load();
      previous = state.exported;
      if (!keep && previous !== null) {
        this.assertExport(state, previous);
        unlinkSync(this.file(state));
        removed = true;
      }
      this.db.prepare('DELETE FROM review WHERE singleton = 1 AND id = ?').run(this.reviewId);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      if (removed && previous !== null) {
        try { this.replace(this.file({ id: this.reviewId, threads: [], exported: previous, markdownPath: this.outputPath }), null, previous); }
        catch (restoreError) { throw new AppAggregateError([error, restoreError], 'reviewCloseFailed'); }
      }
      throw error;
    }
    this.closed = true;
    this.db.close();
  }

  /** Release the database without ending the active review. */
  dispose(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private message(body: string, author: Message['author'] = 'reviewer', published = false): Message {
    if (typeof body !== 'string' || !body.trim()) throw new AppError('invalidMessage');
    return { id: randomUUID(), body, author, published, createdAt: new Date().toISOString() };
  }

  private thread(state: State, id: string): StoredThread {
    const thread = state.threads.find((item) => item.id === id);
    if (!thread) throw new AppError('threadNotFound', { id });
    return thread;
  }

  private fileContents(path: string): Buffer | null {
    if (isAbsolute(path)) return null;
    try {
      const file = realpathSync(resolve(this.root, path));
      const withinRoot = relative(this.root, file);
      if (!withinRoot || withinRoot === '..' || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) return null;
      return readFileSync(file);
    } catch {
      return null;
    }
  }

  private capture(path: string, line: number, startLine = line): { fileHash: string; lineText: string; rangeText?: string[] } | null {
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(startLine) || startLine < 1 || startLine > line) return null;
    const contents = this.fileContents(path);
    if (!contents) return null;
    const lines = contents.toString('utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    if (line > lines.length) return null;
    return { fileHash: createHash('sha256').update(contents).digest('hex'), lineText: lines[line - 1], ...(startLine < line ? { rangeText: lines.slice(startLine - 1, line) } : {}) };
  }

  private view(thread: StoredThread): Thread {
    const { anchor, ...result } = thread;
    if (thread.side === 'old') return { ...result, stale: true };
    if (thread.line === null) return { ...result, stale: false };
    if (!anchor) return { ...result, stale: true };
    const contents = this.fileContents(thread.path);
    if (!contents) return { ...result, stale: true };
    if (anchor.fileHash === createHash('sha256').update(contents).digest('hex')) return { ...result, stale: false };
    const lines = contents.toString('utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const target = thread.startLine === undefined ? [anchor.lineText] : anchor.rangeText;
    if (!target?.length) return { ...result, stale: true };
    let match = -1;
    for (let i = 0; i <= lines.length - target.length; i++) {
      if (target.every((text, offset) => lines[i + offset] === text)) {
        if (match !== -1) return { ...result, stale: true };
        match = i;
      }
    }
    if (match === -1) return { ...result, stale: true };
    return { ...result, ...(thread.startLine === undefined ? {} : { startLine: match + 1 }), line: match + target.length, stale: false };
  }

  private assertOpen(): void {
    if (this.closed) throw new AppError('reviewClosed');
  }

  private load(): State {
    this.assertOpen();
    const row = this.db.prepare('SELECT id, threads, exported, markdown_path FROM review WHERE singleton = 1 AND id = ?').get(this.reviewId) as unknown as Row | undefined;
    if (!row) throw new AppError('reviewInactive');
    const threads = JSON.parse(row.threads) as StoredThread[];
    for (const thread of threads) for (const [index, message] of thread.messages.entries()) {
      message.author ??= 'reviewer';
      if (message.published) message.publishedOrder ??= index + 1;
    }
    return { id: row.id, threads, exported: row.exported, markdownPath: row.markdown_path };
  }

  private file(state: State): string {
    return state.markdownPath;
  }

  private assertExport(state: State, expected: string | null): void {
    const path = this.file(state);
    let ancestor = dirname(path);
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error(`Invalid comments directory: ${dirname(path)}`);
      ancestor = parent;
    }
    if (realpathSync(ancestor) !== ancestor) throw new Error(`Comments directory changed or is a symlink: ${dirname(path)}`);
    let exists = true;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) throw new AppError('markdownNotFile', { path });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
      else throw error;
    }
    if (expected === null ? exists : !exists || readFileSync(path, 'utf8') !== expected) {
      throw new AppError('markdownChanged', { path });
    }
  }

  private replace(path: string, expected: string | null, contents: string): void {
    const directory = dirname(path);
    const state = { id: this.reviewId, threads: [], exported: expected, markdownPath: path };
    this.assertExport(state, expected);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.assertExport(state, expected);
    const temporary = join(dirname(path), `.agentic-review-${this.reviewId}-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      this.assertExport(state, expected);
      if (expected === null) {
        // Linking fails rather than overwriting a file created after the check.
        linkSync(temporary, path);
      } else {
        renameSync(temporary, path);
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  private change<T>(mutate: (state: State) => T, locale: string): T {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    let state: State | undefined;
    let before: string | null = null;
    let after: string | null = null;
    let replaced = false;
    try {
      state = this.load();
      before = state.exported;
      const result = mutate(state);
      const hasPublished = state.threads.some((thread) => thread.messages.some((message) => message.published));
      after = before !== null || hasPublished ? renderReview(state.id, state.threads, locale) : null;
      if (after !== before && after !== null) {
        this.replace(this.file(state), before, after);
        replaced = true;
      }
      this.db.prepare('UPDATE review SET threads = ?, exported = ? WHERE singleton = 1 AND id = ?').run(JSON.stringify(state.threads), after, this.reviewId);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      if (replaced && state && after !== null) {
        try {
          if (before === null) {
            this.assertExport(state, after);
            unlinkSync(this.file(state));
          } else {
            this.replace(this.file(state), after, before);
          }
        } catch (restoreError) {
          throw new AppAggregateError([error, restoreError], 'reviewUpdateFailed');
        }
      }
      throw error;
    }
  }
}
