import type { DiffLine } from './types'

export interface ChangeRange { start: number; end: number }

function compare(oldText: string, newText: string): [ChangeRange[], ChangeRange[]] {
  const old = Array.from(oldText), added = Array.from(newText)
  let prefix = 0
  while (prefix < old.length && prefix < added.length && old[prefix] === added[prefix]) prefix++
  let oldEnd = old.length, newEnd = added.length
  while (oldEnd > prefix && newEnd > prefix && old[oldEnd - 1] === added[newEnd - 1]) { oldEnd--; newEnd-- }
  const n = oldEnd - prefix, m = newEnd - prefix
  const oldChanged = new Uint8Array(n), newChanged = new Uint8Array(m)
  if (!n || !m || n * m > 200_000) {
    oldChanged.fill(1); newChanged.fill(1)
  } else {
    const width = m + 1
    const lengths = new Uint32Array((n + 1) * width)
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      lengths[i * width + j] = old[prefix + i] === added[prefix + j]
        ? lengths[(i + 1) * width + j + 1] + 1
        : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1])
    }
    let i = 0, j = 0
    while (i < n || j < m) {
      if (i < n && j < m && old[prefix + i] === added[prefix + j]) { i++; j++ }
      else if (i < n && (j === m || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) oldChanged[i++] = 1
      else newChanged[j++] = 1
    }
  }
  const common = old.length - oldChanged.reduce((sum, value) => sum + value, 0)
  if (4 * common < Math.max(old.length + added.length, 1)) return [[], []]
  const ranges = (chars: string[], changed: Uint8Array): ChangeRange[] => {
    const result: ChangeRange[] = []
    let offset = 0
    for (let i = 0; i < chars.length; i++) {
      const end = offset + chars[i].length
      if (i >= prefix && i < prefix + changed.length && changed[i - prefix]) {
        const previous = result[result.length - 1]
        if (previous?.end === offset) previous.end = end
        else result.push({ start: offset, end })
      }
      offset = end
    }
    return result
  }
  return [ranges(old, oldChanged), ranges(added, newChanged)]
}

/** Pair replacement lines in the same order as the side-by-side view. */
export function inlineChanges(lines: DiffLine[]): Map<string, ChangeRange[]> {
  const result = new Map<string, ChangeRange[]>()
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind !== 'deletion' && lines[i].kind !== 'addition') { i++; continue }
    const old: DiffLine[] = [], added: DiffLine[] = []
    while (i < lines.length && (lines[i].kind === 'deletion' || lines[i].kind === 'addition')) {
      const line = lines[i++]
      ;(line.kind === 'deletion' ? old : added).push(line)
    }
    for (let j = 0; j < Math.min(old.length, added.length); j++) {
      const [removed, inserted] = compare(old[j].text, added[j].text)
      if (removed.length) result.set(old[j].key, removed)
      if (inserted.length) result.set(added[j].key, inserted)
    }
  }
  return result
}
