const english = {
  unauthorizedHost: 'Unauthorized host',
  unauthorizedOrigin: 'Unauthorized origin',
  invalidComparison: 'Invalid comparison',
  invalidSearch: 'Invalid search',
  invalidPath: 'Invalid path',
  outsideRepository: 'Path outside the repository',
  invalidChoice: 'Invalid choice',
  gitTerminated: 'Git terminated by {signal}',
  gitTerminatedUnknown: 'Git terminated by an unknown signal',
  gitFailed: 'git {command} failed with exit code {code}',
  noUpstream: 'No upstream tracking branch is configured or its commit is unavailable; choose another reference.',
  noBranchBase: 'Cannot reliably determine where this branch was created; choose a reference explicitly.',
  referenceRequired: 'A commit, tag or branch reference is required.',
  unknownDiffMode: 'Unknown diff mode: {mode}',
  unexpectedRawDiff: 'Unexpected git raw diff output',
  incompleteRawDiff: 'Incomplete git raw diff output',
  untrackedDiffFailed: 'Cannot diff untracked file: {path}',
  messageNotFound: 'Message not found: {id}',
  publishedMessageImmutable: 'Published messages cannot be edited or deleted',
  threadNotFound: 'Thread not found: {id}',
  threadNotPublished: 'Thread has no published messages: {id}',
  invalidMessage: 'Message must not be empty',
  reviewClosed: 'Review is closed',
  reviewInactive: 'Review is no longer active',
  markdownNotFile: 'Review Markdown is not a regular file: {path}',
  markdownChanged: 'Review Markdown was changed externally: {path}',
  reviewCloseFailed: 'Review close failed and Markdown could not be restored',
  reviewUpdateFailed: 'Review update failed and Markdown could not be restored',
  reviewTitle: 'Review {id}',
  generalThread: 'General',
  reviewer: 'Reviewer',
  agent: 'Agent',
  side: 'Side',
  status: 'Status',
  resolved: 'resolved',
  old: 'old',
  new: 'new',
  open: 'open',
  cliStarted: 'Review: {url}\nRepository: {root}\nPress Ctrl+C to exit.',
  cliBrowserFailed: 'Could not open the browser: {error}',
  cliStartFailed: 'Could not start the review: {error}',
} as const;

export type MessageKey = keyof typeof english;
type Parameters = Record<string, string | number>;
const catalogs = new Map<string, Partial<Record<MessageKey, string>>>([['en', english]]);

/** Register an additional catalog. Missing messages fall back to English. */
export function registerLocale(locale: string, messages: Partial<Record<MessageKey, string>>): void {
  catalogs.set(locale.toLowerCase().replace(/_/g, '-'), messages);
}

/** Select the best registered language from an Accept-Language header. */
export function resolveLocale(header?: string): string {
  const candidates = (header ?? '').split(',').map((entry, index) => {
    const [language, ...params] = entry.trim().split(';');
    const quality = params.find(param => /^\s*q\s*=/i.test(param));
    const q = quality ? Number(quality.split('=')[1]) : 1;
    return { language: language.trim().toLowerCase().replace(/_/g, '-'), q, index };
  }).filter(candidate => candidate.language && candidate.q > 0 && candidate.q <= 1)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { language } of candidates) {
    if (language === '*') return 'en';
    let candidate = language;
    while (candidate) {
      if (catalogs.has(candidate)) return candidate;
      const dash = candidate.lastIndexOf('-');
      candidate = dash < 0 ? '' : candidate.slice(0, dash);
    }
  }
  return 'en';
}

export function systemLocale(): string {
  const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  return resolveLocale(locale.split(/[.@]/)[0]);
}

export function translate(locale: string, key: MessageKey, params: Parameters = {}): string {
  const template = catalogs.get(locale)?.[key] ?? english[key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) => Object.hasOwn(params, name) ? String(params[name]) : match);
}

export class AppError extends Error {
  constructor(public readonly key: MessageKey, public readonly params: Parameters = {}) {
    super(translate('en', key, params));
  }
  localized(locale: string): string { return translate(locale, this.key, this.params); }
}

export class AppAggregateError extends AggregateError {
  constructor(errors: unknown[], public readonly key: MessageKey) {
    super(errors, translate('en', key));
  }
  localized(locale: string): string { return translate(locale, this.key); }
}

export function errorMessage(error: unknown, locale: string): string {
  if (error instanceof AppError || error instanceof AppAggregateError) return error.localized(locale);
  return error instanceof Error ? error.message : String(error);
}
