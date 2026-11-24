import type { Thread } from './types'

/** Mark only the side and inclusive line range belonging to each discussion. */
export function commentLineClasses(threads: Thread[], oldLine?: number, newLine?: number): Record<string, boolean> {
  const classes: Record<string, boolean> = {}
  for (const thread of threads) {
    const line = thread.side === 'old' ? oldLine : newLine
    if (line === undefined || thread.line === null || line < (thread.startLine ?? thread.line) || line > thread.line) continue
    classes['commented-line'] = true
    classes[thread.side === 'old' ? 'commented-old' : 'commented-new'] = true
    if (line === (thread.startLine ?? thread.line)) classes['comment-range-start'] = true
    if (line === thread.line) classes['comment-range-end'] = true
  }
  return classes
}
