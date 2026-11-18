import type { Thread } from '../review/index.js';
import { translate } from '../locales/index.js';

/** Render only the messages deliberately published for the agent. */
export function renderReview(id: string, threads: Thread[], locale = 'en'): string {
  const sections = [`# ${translate(locale, 'reviewTitle', { id })}`, ''];
  for (const thread of threads) {
    const messages = thread.messages.filter((message) => message.published);
    if (messages.length === 0) continue;
    sections.push(
      `## ${thread.path ? `${JSON.stringify(thread.path)}${thread.line === null ? '' : thread.startLine === undefined ? `:${thread.line}` : `:${thread.startLine}-${thread.line}`}` : translate(locale, 'generalThread')}`,
      '',
      ...(thread.path ? [`- ${translate(locale, 'side')}: ${translate(locale, thread.side)}`] : []),
      `- ${translate(locale, 'status')}: ${translate(locale, thread.resolved ? 'resolved' : 'open')}`,
      '',
    );
    for (const message of messages) {
      sections.push(`### ${translate(locale, message.author === 'agent' ? 'agent' : 'reviewer')} — ${message.createdAt}`, '', message.body, '');
    }
  }
  return sections.join('\n');
}
