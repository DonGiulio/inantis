export interface DiffFile {
  path: string
  oldPath?: string
  status: string
  additions: number
  deletions: number
  binary: boolean
  patch: string
  contextId: string
  uncommitted: boolean
}

export interface Diff {
  root: string
  branch: string
  base: string
  baseIsEmpty: boolean
  baseLabel?: string
  baseRefs: string[]
  baseTags: string[]
  headTags: string[]
  files: DiffFile[]
}

export interface Message {
  id: string
  body: string
  author?: 'reviewer' | 'agent'
  published: boolean
  createdAt: string
}

export interface Thread {
  id: string
  path: string
  line: number | null
  startLine?: number
  side: 'old' | 'new'
  resolved: boolean
  stale?: boolean
  messages: Message[]
}

export interface DiffLine {
  key: string
  kind: 'hunk' | 'context' | 'addition' | 'deletion' | 'meta' | 'gap'
  text: string
  oldLine?: number
  newLine?: number
  hiddenLines?: DiffLine[]
}

export function parsePatch(patch: string): DiffLine[] {
  const result: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  const lines = patch.split('\n')
  for (const [index, text] of lines.entries()) {
    if (index === lines.length - 1 && text === '') continue
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (match) {
      oldLine = Number(match[1])
      newLine = Number(match[2])
      inHunk = true
      result.push({ key: String(index), kind: 'hunk', text })
    } else if (inHunk && text.startsWith('+')) {
      result.push({ key: String(index), kind: 'addition', text: text.slice(1), newLine: newLine++ })
    } else if (inHunk && text.startsWith('-')) {
      result.push({ key: String(index), kind: 'deletion', text: text.slice(1), oldLine: oldLine++ })
    } else if (inHunk && text.startsWith(' ')) {
      result.push({ key: String(index), kind: 'context', text: text.slice(1), oldLine: oldLine++, newLine: newLine++ })
    } else if (inHunk) {
      result.push({ key: String(index), kind: 'meta', text })
    }
  }
  return result
}

/** Insert expandable unchanged ranges around the original, abbreviated hunks. */
export function parseExpandedPatch(patch: string, fullPatch: string): DiffLine[] {
  const visible = parsePatch(patch)
  const full = parsePatch(fullPatch)
  const identity = (line: DiffLine) => `${line.kind}:${line.oldLine ?? ''}:${line.newLine ?? ''}`
  const positions = new Map<string, number>()
  for (const [index, line] of visible.entries()) {
    if (line.kind === 'context' || line.kind === 'addition' || line.kind === 'deletion') {
      positions.set(identity(line), index)
    }
  }

  const insertions = new Map<number, DiffLine[]>()
  let hidden: DiffLine[] = []
  for (const line of full) {
    if (line.kind === 'context' && !positions.has(identity(line))) {
      hidden.push({ ...line, key: `expanded:${line.oldLine}:${line.newLine}` })
      continue
    }
    if (!hidden.length) continue
    const position = positions.get(identity(line))
    if (position === undefined) continue
    const index = position > 0 && visible[position - 1].kind === 'hunk' ? position - 1 : position
    const first = hidden[0]
    const gap: DiffLine = { key: `gap:${first.oldLine}:${first.newLine}`, kind: 'gap', text: '', hiddenLines: hidden }
    insertions.set(index, [...(insertions.get(index) || []), gap])
    hidden = []
  }
  if (hidden.length) {
    const first = hidden[0]
    insertions.set(visible.length, [{ key: `gap:${first.oldLine}:${first.newLine}`, kind: 'gap', text: '', hiddenLines: hidden }])
  }
  const result: DiffLine[] = []
  for (let index = 0; index <= visible.length; index++) {
    result.push(...(insertions.get(index) || []))
    if (index < visible.length) result.push(visible[index])
  }
  return result
}
