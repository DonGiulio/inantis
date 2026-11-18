<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { t } from './i18n'
import ThreadView from './ThreadView.vue'
import CodeText from './CodeText.vue'
import SplitDiff from './SplitDiff.vue'
import SelectionSearch from './SelectionSearch.vue'
import IgnoreWarning from './IgnoreWarning.vue'
import ContextGap from './ContextGap.vue'
import FileIcon from './FileIcon.vue'
import Walkthrough from './Walkthrough.vue'
import { findFolds } from './folding'
import { parsePatch, parseExpandedPatch, type Diff, type DiffFile, type DiffLine, type Thread } from './types'

type Mode = 'working' | 'upstream' | 'branch' | 'ref'
const mode = ref<Mode>('branch')
const reference = ref('')
const diff = ref<Diff | null>(null)
const threads = ref<Thread[]>([])
const search = ref('')
const selectedText = ref('')
const selectionCounts = ref<Record<string, number>>({})
const selectionFiles = new Map<string, string>()
let selectionRequest = 0
const tree = ref(true)
const split = ref(false)
const wrap = ref(false)
const sidebarWidth = ref(260)
let sidebarDrag: { pointerId: number; x: number; width: number } | null = null
function resizeSidebar(width: number) {
  sidebarWidth.value = Math.max(180, Math.min(Math.max(180, window.innerWidth - 320), width))
}
function startSidebarResize(event: PointerEvent) {
  if (event.button !== 0) return
  sidebarDrag = { pointerId: event.pointerId, x: event.clientX, width: sidebarWidth.value }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  event.preventDefault()
}
function moveSidebarResize(event: PointerEvent) {
  if (sidebarDrag?.pointerId === event.pointerId) resizeSidebar(sidebarDrag.width + event.clientX - sidebarDrag.x)
}
function endSidebarResize(event: PointerEvent) {
  if (sidebarDrag?.pointerId === event.pointerId) sidebarDrag = null
}
function sidebarResizeKey(event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  resizeSidebar(sidebarWidth.value + (event.key === 'ArrowLeft' ? -20 : 20))
  event.preventDefault()
}
function clampSidebar() { resizeSidebar(sidebarWidth.value) }
const view = ref<'changes' | 'discussions' | 'file'>('changes')
const codeQuery = ref('')
const codeResults = ref<{ path: string; line: number; text: string }[] | null>(null)
const searching = ref(false)
const reviewed = ref<Record<string, string>>({})
let reviewedRoot = ''
const restoredReviewed = new Set<string>()
const collapsed = ref<Set<string>>(new Set())
const error = ref('')
const loading = ref(false)
const comparisonWarning = ref('')
const filePath = ref('')
const openedFile = ref<{ path: string; content: string } | null>(null)
const composer = ref<{ path: string; line: number; startLine?: number; side: 'old' | 'new' } | null>(null)
const vFocus = { mounted(element: HTMLTextAreaElement) { element.focus() } }
const comment = ref('')
const generalComment = ref('')
const composingGeneral = ref(false)
const busy = ref(false)
const closed = ref(false)
const tourOpen = ref(false)
function startTour() { view.value = 'changes'; tourOpen.value = true }
let events: EventSource | undefined
const contexts = ref(new Map<string, DiffLine[]>())
const expandedGaps = ref(new Map<string, { top: number; bottom: number }>())
const loadingContext = ref(new Set<string>())
let diffRequest: AbortController | undefined
let requestVersion = 0
const stateKey = 'agentic-review-view'
function saveView() {
  sessionStorage.setItem(stateKey, JSON.stringify({ split: split.value, wrap: wrap.value, tree: tree.value, sidebarWidth: sidebarWidth.value, view: view.value, path: openedFile.value?.path, scrollX: window.scrollX, scrollY: window.scrollY }))
}

const filteredFiles = computed(() => (diff.value?.files || []).filter(file => file.path.toLowerCase().includes(search.value.toLowerCase())))
const activeFile = ref('')
let activeFileFrame = 0
function updateActiveFile() {
  activeFileFrame = 0
  const threshold = Math.min(window.innerHeight * 0.35, 240)
  const cards = document.querySelectorAll<HTMLElement>('.file-card[data-diff-path]')
  let current = ''
  for (const card of cards) {
    const rect = card.getBoundingClientRect()
    if (rect.bottom > threshold && rect.top < window.innerHeight) { current = card.dataset.diffPath ?? ''; break }
  }
  activeFile.value = current
}
function scheduleActiveFile() {
  if (!activeFileFrame) activeFileFrame = window.setTimeout(updateActiveFile, 0)
}
watch(() => [view.value, ...filteredFiles.value.map(file => file.path), collapsed.value.size], async () => { await nextTick(); scheduleActiveFile() })
const orphanedThreads = computed(() => threads.value.filter(thread => thread.path && !(diff.value?.files || []).some(file => file.path === thread.path || file.oldPath === thread.path)))
const hasDrafts = computed(() => threads.value.some(thread => thread.messages.some(message => !message.published)))
function unplacedFileThreads(file: DiffFile) {
  const lines = parsed.value.get(file.path) || []
  return threads.value.filter(thread => (thread.path === file.path || thread.path === file.oldPath) &&
    !(thread.path === file.path && lines.some(line => thread.side === 'old' ? line.oldLine === thread.line : line.newLine === thread.line)))
}
function unplacedOpenedThreads(path: string, content: string) {
  const lineCount = content.split('\n').length
  return threads.value.filter(thread => thread.path === path && (thread.side !== 'new' || thread.line === null || thread.line > lineCount))
}
const groups = computed(() => {
  const result = new Map<string, DiffFile[]>()
  for (const file of filteredFiles.value) {
    const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '.'
    result.set(dir, [...(result.get(dir) || []), file])
  }
  return result
})
const totals = computed(() => (diff.value?.files || []).reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 }))
function initialGaps(patch: string): DiffLine[] {
  const lines = parsePatch(patch)
  const result: DiffLine[] = []
  let oldNext = 1, newNext = 1
  for (const line of lines) {
    if (line.kind === 'hunk') {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line.text)
      if (match) {
        const oldCount = match[2] === undefined ? 1 : Number(match[2])
        const newCount = match[4] === undefined ? 1 : Number(match[4])
        const oldFirst = Number(match[1]) + (oldCount === 0 ? 1 : 0)
        const newFirst = Number(match[3]) + (newCount === 0 ? 1 : 0)
        if (oldFirst > oldNext && oldFirst - oldNext === newFirst - newNext) {
          result.push({ key: `gap:${oldNext}:${newNext}`, kind: 'gap', text: '' })
        }
        oldNext = oldFirst + oldCount
        newNext = newFirst + newCount
      }
    }
    result.push(line)
  }
  result.push({ key: 'gap:tail', kind: 'gap', text: '' })
  return result
}
const parsed = computed(() => new Map((diff.value?.files || []).map(file => {
  const lines = contexts.value.get(file.contextId) ?? initialGaps(file.patch || '')
  return [file.path, lines.flatMap(line => {
    if (line.kind !== 'gap' || !line.hiddenLines) return [line]
    const progress = expandedGaps.value.get(`${file.contextId}:${line.key}`) ?? { top: 0, bottom: 0 }
    const hidden = line.hiddenLines
    const top = Math.min(progress.top, hidden.length)
    const bottom = Math.min(progress.bottom, hidden.length - top)
    return [...hidden.slice(0, top), ...(top + bottom < hidden.length ? [line] : []), ...hidden.slice(hidden.length - bottom)]
  })]
})))
const openedLines = computed(() => openedFile.value?.content.split('\n') ?? [])
const openedFolds = computed(() => openedFile.value ? findFolds(openedLines.value, openedFile.value.path) : new Map<number, number>())
const closedOpenedFolds = ref(new Set<number>())
const closedDiffFolds = ref(new Map<string, Set<string>>())
const diffFolds = computed(() => new Map((diff.value?.files || []).map(file => {
  const lines = parsed.value.get(file.path) || []
  const folds = new Map<number, number>()
  for (let start = 0; start < lines.length;) {
    const kind = lines[start].kind
    if (kind !== 'context' && kind !== 'addition' && kind !== 'deletion') { start++; continue }
    let end = start + 1
    while (end < lines.length && lines[end].kind === kind &&
      (kind === 'addition' || lines[end].oldLine === (lines[end - 1].oldLine ?? 0) + 1) &&
      (kind === 'deletion' || lines[end].newLine === (lines[end - 1].newLine ?? 0) + 1)) end++
    for (const [first, last] of findFolds(lines.slice(start, end).map(line => line.text), file.path)) folds.set(start + first, start + last)
    start = end
  }
  return [file.contextId, folds]
})))
function toggleFold(set: Set<number>, index: number) {
  if (set.has(index)) set.delete(index); else set.add(index)
}
function toggleDiffFold(id: string, key: string) {
  const set = closedDiffFolds.value.get(id) ?? new Set<string>()
  if (set.has(key)) set.delete(key); else set.add(key)
  closedDiffFolds.value.set(id, set)
}
function hiddenFold(index: number, folds: Map<number, number>, isClosed: (start: number) => boolean) {
  for (const [start, end] of folds) if (start < index && index <= end && isClosed(start)) return true
  return false
}

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options)
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || t('httpError', { status: response.status }))
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

watch(() => [selectedText.value, diff.value?.root, ...(diff.value?.files.map(file => `${file.path}:${file.contextId}`) ?? [])], async () => {
  const request = ++selectionRequest
  const query = selectedText.value
  selectionCounts.value = {}
  if (!query || !diff.value) return
  const root = diff.value.root
  const files = diff.value.files.filter(file => !file.binary && file.status !== 'D')
  const counts = await Promise.all(files.map(async file => {
    const key = `${root}:${file.path}:${file.contextId}`
    let content = selectionFiles.get(key)
    if (content === undefined) {
      try {
        content = (await api<{ content: string }>(`/api/file?${new URLSearchParams({ path: file.path })}`)).content
        selectionFiles.set(key, content)
      } catch { return [file.path, 0] as const }
    }
    let count = 0
    for (let offset = 0; ;) {
      const index = content.indexOf(query, offset)
      if (index < 0) break
      count++
      offset = index + query.length
    }
    return [file.path, count] as const
  }))
  if (request === selectionRequest) selectionCounts.value = Object.fromEntries(counts)
})
async function expandGap(file: DiffFile, key: string, direction: 'top' | 'bottom' | 'all') {
  if (loadingContext.value.has(file.contextId)) return
  let lines = contexts.value.get(file.contextId)
  if (!lines) {
    loadingContext.value.add(file.contextId)
    try {
      const query = new URLSearchParams({ mode: mode.value, path: file.path, id: file.contextId })
      if (reference.value.trim() && (mode.value === 'ref' || mode.value === 'branch')) query.set('ref', reference.value.trim())
      const data = await api<{ patch: string }>(`/api/diff/context?${query}`)
      if (!diff.value?.files.some(item => item.contextId === file.contextId)) return
      lines = parseExpandedPatch(file.patch, data.patch)
      contexts.value.set(file.contextId, lines)
    } catch (e) { report(e); return }
    finally { loadingContext.value.delete(file.contextId) }
  }
  const gap = key === 'gap:tail' ? (lines.at(-1)?.kind === 'gap' ? lines.at(-1) : undefined) : lines.find(line => line.key === key)
  if (gap?.hiddenLines) {
    const id = `${file.contextId}:${gap.key}`
    const progress = expandedGaps.value.get(id) ?? { top: 0, bottom: 0 }
    if (direction === 'all') progress.top = gap.hiddenLines.length
    else progress[direction] += 20
    expandedGaps.value.set(id, { ...progress })
  }
}
function report(e: unknown) { error.value = e instanceof Error ? e.message : String(e) }
async function loadDiff(initial = false) {
  const version = ++requestVersion
  diffRequest?.abort()
  const controller = new AbortController()
  diffRequest = controller
  loading.value = true
  try {
    const query = new URLSearchParams({ mode: mode.value })
    if (reference.value.trim() && (mode.value === 'ref' || mode.value === 'branch')) query.set('ref', reference.value.trim())
    const response = await fetch(`/api/diff/stream?${query}`, { signal: controller.signal })
    if (!response.ok || !response.body) throw new Error(t('httpError', { status: response.status }))
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const seen = new Set<string>()
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const records = buffer.split('\n')
      buffer = records.pop() || ''
      for (const record of records) {
        if (!record || version !== requestVersion) continue
        const event = JSON.parse(record) as ({ type: 'metadata' } & Omit<Diff, 'files'>) | { type: 'file'; file: DiffFile } | { type: 'error'; error: string; code?: string }
        if (event.type === 'error') {
          if (initial && event.code === 'noBranchBase' && mode.value === 'branch' && !reference.value.trim()) {
            mode.value = 'working'
            comparisonWarning.value = t('branchFallback')
            await loadDiff()
            return
          }
          throw new Error(event.error)
        }
        if (event.type === 'metadata') {
          const { type: _, ...metadata } = event
          if (reviewedRoot !== metadata.root) {
            reviewedRoot = metadata.root
            try { reviewed.value = JSON.parse(localStorage.getItem(`reviewed:${reviewedRoot}`) || '{}') } catch { reviewed.value = {} }
          }
          if (!diff.value || diff.value.root !== metadata.root || diff.value.base !== metadata.base || diff.value.branch !== metadata.branch) {
            diff.value = { ...metadata, files: [] }
          } else {
            Object.assign(diff.value, metadata, { baseLabel: metadata.baseLabel })
          }
        }
        else {
          seen.add(event.file.path)
          const files = diff.value?.files
          if (files) {
            const index = files.findIndex(file => file.path === event.file.path)
            if (index < 0) files.push(event.file)
            else if (files[index].contextId !== event.file.contextId || files[index].uncommitted !== event.file.uncommitted) files.splice(index, 1, event.file)
          }
          if (reviewed.value[event.file.path] === event.file.contextId && !restoredReviewed.has(event.file.contextId)) {
            restoredReviewed.add(event.file.contextId)
            collapsed.value.add(event.file.path)
          }
        }
      }
      if (done) break
    }
    if (version === requestVersion && diff.value) {
      if (diff.value.files.some(file => !seen.has(file.path))) diff.value.files = diff.value.files.filter(file => seen.has(file.path))
      error.value = ''
    }
  } catch (e) { if (version === requestVersion && !controller.signal.aborted) report(e) }
  finally { if (version === requestVersion) loading.value = false }
}
function changeMode() {
  reference.value = ''
  comparisonWarning.value = ''
  diff.value = null
  error.value = ''
  ++requestVersion
  loading.value = false
  if (mode.value !== 'ref') void loadDiff()
}
async function loadThreads() {
  try { threads.value = await api<Thread[]>('/api/threads') } catch (e) { report(e) }
}
function refresh() { if (mode.value !== 'ref' || reference.value.trim()) void loadDiff(); void loadThreads() }
async function openFile(path = filePath.value.trim(), line?: number) {
  if (!path) return
  try {
    const data = await api<{ content: string }>(`/api/file?${new URLSearchParams({ path })}`)
    closedOpenedFolds.value = new Set()
    openedFile.value = { path, content: data.content }
    view.value = 'file'
    filePath.value = path
    error.value = ''
    requestAnimationFrame(() => document.getElementById(line ? `opened-line-${line}` : 'opened-file')?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  } catch (e) { report(e) }
}
async function searchCode() {
  if (!codeQuery.value.trim()) return
  searching.value = true
  try {
    const data = await api<{ matches: { path: string; line: number; text: string }[] }>(`/api/search?${new URLSearchParams({ q: codeQuery.value })}`)
    codeResults.value = data.matches
    error.value = ''
  } catch (e) { report(e) } finally { searching.value = false }
}
function toggle(path: string) {
  const next = new Set(collapsed.value)
  if (next.has(path)) next.delete(path); else next.add(path)
  collapsed.value = next
}
function toggleReviewed(file: DiffFile) {
  const next = { ...reviewed.value }
  if (next[file.path] === file.contextId) delete next[file.path]
  else next[file.path] = file.contextId
  reviewed.value = next
  restoredReviewed.add(file.contextId)
  localStorage.setItem(`reviewed:${reviewedRoot}`, JSON.stringify(next))
  const collapsedNext = new Set(collapsed.value)
  if (next[file.path] === file.contextId) collapsedNext.add(file.path); else collapsedNext.delete(file.path)
  collapsed.value = collapsedNext
}
function jump(path: string) {
  activeFile.value = path
  if (collapsed.value.has(path)) toggle(path)
  requestAnimationFrame(() => document.getElementById(`file-${path}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}
function lineThreads(path: string, line: DiffLine) {
  return threads.value.filter(thread => thread.path === path && (thread.side === 'old' ? line.oldLine === thread.line : line.newLine === thread.line))
}
type CommentSide = 'old' | 'new'
const commentAnchor = ref<number | null>(null)
let commentDrag: { pointerId: number; path: string; side: CommentSide; start: number; end: number; moved: boolean } | null = null
const commentDragging = ref(false)
let suppressCommentClick = false
function selectCommentRange(path: string, start: number, end: number, side: CommentSide) {
  const first = Math.min(start, end), last = Math.max(start, end)
  composer.value = { path, line: last, ...(first !== last ? { startLine: first } : {}), side }
  commentAnchor.value = start
}
function beginComment(path: string, line: number, side: CommentSide, event: MouseEvent) {
  if (suppressCommentClick) { suppressCommentClick = false; return }
  if (event.shiftKey && composer.value?.path === path && composer.value.side === side && commentAnchor.value !== null) {
    selectCommentRange(path, commentAnchor.value, line, side); return
  }
  if (composer.value?.path === path && composer.value.line === line && composer.value.side === side) { composer.value = null; commentAnchor.value = null; comment.value = ''; return }
  selectCommentRange(path, line, line, side); comment.value = ''
}
function startCommentDrag(event: PointerEvent, path: string, line: number | undefined, side: CommentSide) {
  if (event.button !== 0 || event.shiftKey || line === undefined) return
  commentDrag = { pointerId: event.pointerId, path, side, start: line, end: line, moved: false }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function moveCommentDrag(event: PointerEvent) {
  if (!commentDrag || commentDrag.pointerId !== event.pointerId) return
  const target = document.elementFromPoint(event.clientX, event.clientY)
  const row = target?.closest<HTMLElement>('.code-row[data-comment-path]')
  const gutter = target?.closest<HTMLElement>('[data-comment-side]')
  if (!row || row.dataset.commentPath !== commentDrag.path || (gutter && gutter.dataset.commentSide !== commentDrag.side)) return
  const raw = commentDrag.side === 'old' ? row.dataset.oldLine : row.dataset.newLine
  if (raw === undefined) return
  const line = Number(raw)
  if (!Number.isSafeInteger(line) || line < 1) return
  commentDrag.end = line
  if (line !== commentDrag.start) commentDrag.moved = true
  if (commentDrag.moved) { commentDragging.value = true; selectCommentRange(commentDrag.path, commentDrag.start, line, commentDrag.side); event.preventDefault() }
}
function endCommentDrag(event: PointerEvent) {
  if (!commentDrag || commentDrag.pointerId !== event.pointerId) return
  if (commentDrag.moved) {
    selectCommentRange(commentDrag.path, commentDrag.start, commentDrag.end, commentDrag.side)
    suppressCommentClick = true
    setTimeout(() => { suppressCommentClick = false }, 0)
  }
  commentDragging.value = false
  commentDrag = null
}
function selectedComment(path: string, line: number | undefined, side: CommentSide) {
  return line !== undefined && composer.value?.path === path && composer.value.side === side && line >= (composer.value.startLine ?? composer.value.line) && line <= composer.value.line
}
function isComposer(path: string, line: DiffLine) {
  return !commentDragging.value && composer.value?.path === path && (composer.value.side === 'old' ? composer.value.line === line.oldLine : composer.value.line === line.newLine)
}
async function saveComment(published = false) {
  if (busy.value || !composer.value || !comment.value.trim()) return
  busy.value = true
  try {
    await api('/api/threads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...composer.value, body: comment.value, published }) })
    composer.value = null; comment.value = ''; await loadThreads(); error.value = ''
  } catch (e) { report(e) } finally { busy.value = false }
}
async function saveGeneralComment(published = false) {
  if (busy.value || !generalComment.value.trim()) return
  busy.value = true
  try {
    await api('/api/threads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '', line: null, side: 'new', body: generalComment.value, published }) })
    generalComment.value = ''; composingGeneral.value = false; await loadThreads(); error.value = ''
  } catch (e) { report(e) } finally { busy.value = false }
}
async function completeReview() {
  if (busy.value || !hasDrafts.value) return
  busy.value = true
  try {
    await api('/api/review/publish', { method: 'POST' })
    await loadThreads(); error.value = ''
  } catch (e) { report(e) } finally { busy.value = false }
}
async function closeReview(keep: boolean) {
  busy.value = true
  try {
    await api('/api/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keep }) })
    events?.close(); closed.value = true
  } catch (e) { report(e) } finally { busy.value = false }
}
onMounted(async () => {
  let saved: { split?: boolean; wrap?: boolean; tree?: boolean; sidebarWidth?: number; view?: 'changes' | 'discussions' | 'file'; path?: string; scrollX?: number; scrollY?: number } = {}
  try { saved = JSON.parse(sessionStorage.getItem(stateKey) || '{}') } catch { /* Ignore invalid saved state. */ }
  split.value = saved.split === true
  wrap.value = saved.wrap === true
  tree.value = saved.tree !== false
  if (typeof saved.sidebarWidth === 'number' && Number.isFinite(saved.sidebarWidth)) resizeSidebar(saved.sidebarWidth)
  window.addEventListener('resize', clampSidebar)
  view.value = saved.view === 'discussions' ? 'discussions' : 'changes'
  window.addEventListener('pagehide', saveView)
  window.addEventListener('scroll', scheduleActiveFile, { passive: true })
  window.addEventListener('resize', scheduleActiveFile)
  await Promise.all([loadDiff(true), loadThreads()])
  if (saved.view === 'file' && saved.path) {
    try {
      const data = await api<{ content: string }>(`/api/file?${new URLSearchParams({ path: saved.path })}`)
      openedFile.value = { path: saved.path, content: data.content }
      view.value = 'file'
    } catch (e) { report(e) }
  }
  const url = new URL(window.location.href)
  if (url.searchParams.get('tour') === '1') {
    url.searchParams.delete('tour')
    // The launch URL opts in once; refreshes should not restart the tour.
    window.history.replaceState(window.history.state, '', url)
    startTour()
  }
  await nextTick()
  window.scrollTo(saved.scrollX ?? 0, saved.scrollY ?? 0)
  events = new EventSource('/api/events')
  events.onopen = () => refresh()
  events.onmessage = () => refresh()
  events.onerror = () => { error.value = t('connectionInterrupted') }
})
onUnmounted(() => { window.removeEventListener('pagehide', saveView); window.removeEventListener('resize', clampSidebar); window.removeEventListener('resize', scheduleActiveFile); window.removeEventListener('scroll', scheduleActiveFile); window.clearTimeout(activeFileFrame); events?.close() })
</script>

<template>
  <header class="topbar"><div class="brand"><span class="brand-mark">◈</span> {{ t('appTitle') }}</div><span v-if="diff" class="repo-path" :title="diff.root">{{ diff.root }}</span><button v-if="!closed" type="button" :aria-label="t('tourOpen')" :title="t('tourOpen')" @click="startTour">?</button><button v-if="!closed && hasDrafts" class="primary" :disabled="busy" @click="completeReview">{{ t('completeReview') }}</button><details class="close-menu"><summary>{{ t('closeReview') }}</summary><div class="close-panel"><p>{{ t('keepMarkdown') }}</p><div class="actions"><button :disabled="busy" @click="closeReview(true)">{{ t('keep') }}</button><button class="danger" :disabled="busy" @click="closeReview(false)">{{ t('delete') }}</button></div></div></details></header>
  <SelectionSearch v-if="!closed" @selection="selectedText = $event" />
  <IgnoreWarning v-if="!closed" />
  <Walkthrough v-if="!closed && tourOpen" @close="tourOpen = false" />
  <main v-if="!closed">
    <div class="page-title"><div class="breadcrumbs">{{ t('repository') }} <span>/</span> {{ t('localReview') }}</div><h1>{{ t('codeChanges') }}</h1><p>{{ t('reviewDescription') }}</p></div>
    <div class="tabs"><button class="text-button" :class="{ 'active-tab': view === 'changes' }" @click="view = 'changes'">{{ t('changes') }} <span class="count">{{ diff?.files.length || 0 }}</span></button><button class="text-button" :class="{ 'active-tab': view === 'discussions' }" @click="view = 'discussions'">{{ t('discussions') }} <span class="count">{{ threads.length }}</span></button><button v-if="view !== 'discussions'" class="general-discussion-button" @click="view = 'discussions'; composingGeneral = true">+ {{ t('newDiscussion') }}</button></div>
    <div v-if="error" class="error" role="alert"><span>{{ error }}</span><button :aria-label="t('dismissMessage')" @click="error = ''">×</button></div>
    <div v-if="comparisonWarning" class="error" role="status"><span>{{ comparisonWarning }}</span><button :aria-label="t('dismissMessage')" @click="comparisonWarning = ''">×</button></div>
    <div v-if="view === 'changes'" class="toolbar">
      <form class="comparison" @submit.prevent="loadDiff()"><label for="mode">{{ t('compare') }}</label><select id="mode" v-model="mode" @change="changeMode"><option value="working">{{ t('localChanges') }}</option><option value="upstream">{{ t('unpushedChanges') }}</option><option value="branch">{{ t('sinceBranch') }}</option><option value="ref">{{ t('fromReference') }}</option></select><template v-if="mode === 'ref' || mode === 'branch'"><label class="sr-only" for="reference">{{ t('gitReference') }}</label><input id="reference" v-model="reference" :placeholder="t('referencePlaceholder')" :required="mode === 'ref'"><button>{{ t('compare') }}</button></template><span v-if="diff" class="comparison-info"><span v-if="diff.baseIsEmpty">{{ t('emptyTree') }}</span><span v-else :title="diff.base">{{ diff.baseLabel ? `${diff.baseLabel} (${diff.base.slice(0, 12)})` : diff.base.slice(0, 12) }}</span><span v-for="ref in diff.baseRefs.filter(ref => ref !== diff?.baseLabel)" :key="`ref:${ref}`" class="comparison-tag" :title="t('branchAtBase')">{{ ref }}</span><span v-for="tag in diff.baseTags" :key="`base:${tag}`" class="comparison-tag" :title="t('tagAtBase')">{{ tag }}</span> → {{ diff.branch }}<span v-for="tag in diff.headTags" :key="`head:${tag}`" class="comparison-tag" :title="t('tagAtHead')">{{ tag }}</span> + {{ t('workingTree') }}</span></form>
      <div class="summary"><span>{{ t('filesCount', { count: diff?.files.length || 0 }) }}</span> <b class="added">+{{ totals.additions }}</b> <b class="removed">−{{ totals.deletions }}</b><div class="view-switch" :aria-label="t('diffView')"><button :class="{ selected: !split }" :aria-pressed="!split" @click="split = false">{{ t('unified') }}</button><button :class="{ selected: split }" :aria-pressed="split" @click="split = true">{{ t('sideBySide') }}</button></div><button :class="{ selected: wrap }" :aria-pressed="wrap" @click="wrap = !wrap">{{ t('wrapLines') }}</button><button :disabled="loading" :aria-label="t('refreshChanges')" :title="t('refreshChanges')" @click="refresh">↻</button></div>
    </div>
    <div class="layout" :class="{ 'full-width': view !== 'changes' }" :style="{ '--sidebar-width': `${sidebarWidth}px` }">
      <aside v-if="view === 'changes'" class="sidebar" :aria-label="t('fileNavigation')">
        <div class="sidebar-title"><strong>{{ t('files') }} <span class="count">{{ diff?.files.length || 0 }}</span></strong><div class="view-switch"><button :class="{ selected: !tree }" :aria-label="t('listView')" :aria-pressed="!tree" @click="tree = false">☰</button><button :class="{ selected: tree }" :aria-label="t('treeView')" :aria-pressed="tree" @click="tree = true">⊞</button></div></div>
        <label class="sr-only" for="search">{{ t('searchChangedFiles') }}</label><input id="search" v-model="search" class="search" :placeholder="t('searchFilesPlaceholder')">
        <nav v-if="tree" :aria-label="t('changedFiles')"><div v-for="[dir, files] in groups" :key="dir" class="file-group"><div class="directory" :title="dir"><FileIcon directory /><span class="directory-prefix">{{ dir.slice(0, -16) }}</span><span class="directory-suffix">{{ dir.slice(-16) }}</span></div><button v-for="file in files" :key="file.path" class="file-link nested" :class="{ reviewed: reviewed[file.path] === file.contextId, 'active-file': activeFile === file.path }" :aria-current="activeFile === file.path ? 'location' : undefined" @click="jump(file.path)"><span class="file-name"><FileIcon :path="file.path" /> {{ file.path.split('/').pop() }} <span v-if="selectionCounts[file.path]" class="selection-count" :title="t('selectionOccurrences', { count: selectionCounts[file.path] })">{{ selectionCounts[file.path] }}</span></span><span class="file-stats"><span class="added">+{{ file.additions }}</span> <span class="removed">−{{ file.deletions }}</span></span></button></div></nav>
        <nav v-else :aria-label="t('changedFiles')"><button v-for="file in filteredFiles" :key="file.path" class="file-link" :class="{ reviewed: reviewed[file.path] === file.contextId, 'active-file': activeFile === file.path }" :aria-current="activeFile === file.path ? 'location' : undefined" @click="jump(file.path)"><span class="file-name"><FileIcon :path="file.path" /> {{ file.path }} <span v-if="selectionCounts[file.path]" class="selection-count" :title="t('selectionOccurrences', { count: selectionCounts[file.path] })">{{ selectionCounts[file.path] }}</span></span><span class="file-stats"><span class="added">+{{ file.additions }}</span> <span class="removed">−{{ file.deletions }}</span></span></button></nav>
        <p v-if="!filteredFiles.length" class="muted">{{ t('noFiles') }}</p>
        <form class="open-file" @submit.prevent="openFile()"><label for="file-path"><strong>{{ t('openAFile') }}</strong></label><p>{{ t('browseFiles') }}</p><input id="file-path" v-model="filePath" :placeholder="t('pathPlaceholder')" required><button>{{ t('openFile') }}</button></form>
        <form class="open-file" @submit.prevent="searchCode"><label for="code-query"><strong>{{ t('searchCode') }}</strong></label><p>{{ t('searchRepository') }}</p><input id="code-query" v-model="codeQuery" :placeholder="t('searchPlaceholder')" required><button :disabled="searching">{{ t(searching ? 'searching' : 'search') }}</button></form>
        <div v-if="codeResults" class="search-results" aria-live="polite"><p v-if="!codeResults.length" class="muted">{{ t('noResults') }}</p><button v-for="result in codeResults" :key="`${result.path}:${result.line}`" class="search-result" @click="openFile(result.path, result.line)"><strong>{{ result.path }}:{{ result.line }}</strong><span>{{ result.text }}</span></button></div>
      </aside>
      <div v-if="view === 'changes'" class="sidebar-resizer" role="separator" tabindex="0" aria-orientation="vertical" :aria-label="t('resizeSidebar')" :aria-valuenow="sidebarWidth" :title="t('resizeSidebar')" @pointerdown="startSidebarResize" @pointermove="moveSidebarResize" @pointerup="endSidebarResize" @pointercancel="endSidebarResize" @keydown="sidebarResizeKey"></div>
      <div class="content">
        <section v-if="view === 'file' && openedFile" id="opened-file" class="file-card">
          <div class="file-header"><FileIcon :path="openedFile.path" /><strong>{{ openedFile.path }}</strong><button @click="openedFile = null; view = 'changes'">{{ t('closeFile') }}</button></div>
          <ThreadView v-for="thread in unplacedOpenedThreads(openedFile.path, openedFile.content)" :key="thread.id" :thread="thread" show-location @changed="loadThreads" @error="error = $event" @open-file="openFile($event)" />
          <div class="diff-scroll" @pointercancel.capture="commentDragging = false">
            <template v-for="(text, index) in openedLines" :key="index">
              <template v-if="!hiddenFold(index, openedFolds, start => closedOpenedFolds.has(start))">
              <div :id="`opened-line-${index + 1}`" class="code-row context" :class="{ 'range-selected': selectedComment(openedFile.path, index + 1, 'new') }" :data-comment-path="openedFile.path" :data-new-line="index + 1">
                <button v-if="openedFolds.has(index)" type="button" class="fold-toggle" :aria-expanded="!closedOpenedFolds.has(index)" :aria-label="t(closedOpenedFolds.has(index) ? 'expandFold' : 'collapseFold', { line: index + 1 })" @click="toggleFold(closedOpenedFolds, index)">{{ closedOpenedFolds.has(index) ? '▸' : '▾' }}</button><span v-else class="fold-spacer"></span>
                <button class="line-number comment-trigger" data-comment-side="new" :aria-label="t('commentOnLine', { line: index + 1 })" :aria-pressed="selectedComment(openedFile.path, index + 1, 'new')" title="Click to comment; Shift-click or drag to select a range" @pointerdown="startCommentDrag($event, openedFile.path, index + 1, 'new')" @pointermove="moveCommentDrag" @pointerup="endCommentDrag" @pointercancel="commentDrag = null" @click="beginComment(openedFile.path, index + 1, 'new', $event)">{{ index + 1 }}</button><CodeText :path="openedFile.path" :text="text" />
              </div>
              <div v-if="closedOpenedFolds.has(index) && openedFolds.has(index)" class="fold-summary">{{ t('hiddenFoldLines', { count: openedFolds.get(index)! - index }) }}</div>
              <div class="line-threads"><ThreadView v-for="(thread, threadIndex) in threads.filter(t => t.path === openedFile?.path && t.side === 'new' && t.line === index + 1)" :key="thread.id" :thread="thread" :style="{ '--thread-index': threadIndex }" compact @changed="loadThreads" @error="error = $event" @open-file="openFile($event)" /></div>
              <form v-if="!commentDragging && composer?.path === openedFile.path && composer.side === 'new' && composer.line === index + 1" class="composer" @submit.prevent="saveComment()"><textarea v-focus v-model="comment" :aria-label="t('newComment')" :placeholder="t('writeComment')" rows="3"></textarea><div class="actions"><button class="primary" :disabled="busy || !comment.trim()">{{ t('addToReview') }}</button><button type="button" :disabled="busy || !comment.trim()" @click="saveComment(true)">{{ t('sendNow') }}</button><button type="button" :disabled="busy" @click="composer = null">{{ t('cancel') }}</button></div></form>
              </template>
            </template>
          </div>
        </section>
        <template v-if="view === 'changes'">
        <p v-if="loading && !diff" class="empty">{{ t('loadingChanges') }}</p><p v-else-if="diff && !diff.files.length" class="empty">{{ t('noChanges') }}</p>
        <section v-for="file in filteredFiles" :id="`file-${file.path}`" :key="file.path" class="file-card" :data-diff-path="file.path">
          <div v-if="file.uncommitted" class="uncommitted-indicator">{{ t('uncommitted') }}</div>
          <div class="file-header"><button class="collapse" :aria-expanded="!collapsed.has(file.path)" :aria-label="t(collapsed.has(file.path) ? 'expandFile' : 'collapseFile', { path: file.path })" @click="toggle(file.path)">{{ collapsed.has(file.path) ? '›' : '⌄' }}</button><FileIcon :path="file.path" /><strong>{{ file.path }}</strong><span v-if="file.oldPath" class="muted">{{ t('fromPath', { path: file.oldPath }) }}</span><span class="status">{{ file.status }}</span><span class="file-actions"><button v-if="!file.binary && file.status !== 'D'" class="file-action" :aria-label="t('openFullFile')" :title="t('openFullFile')" @click="openFile(file.path)">▤</button><button class="file-action" :aria-pressed="reviewed[file.path] === file.contextId" :aria-label="t(reviewed[file.path] === file.contextId ? 'markUnreviewed' : 'markReviewed')" :title="t(reviewed[file.path] === file.contextId ? 'markUnreviewed' : 'markReviewed')" @click="toggleReviewed(file)">{{ reviewed[file.path] === file.contextId ? '✓' : '○' }}</button></span><span class="file-header-stats"><span class="added">+{{ file.additions }}</span> <span class="removed">−{{ file.deletions }}</span></span></div>
          <ThreadView v-for="thread in unplacedFileThreads(file)" :key="thread.id" :thread="thread" show-location @changed="loadThreads" @error="error = $event" @open-file="openFile($event)" />
          <div v-if="!collapsed.has(file.path)" class="diff-scroll" :class="{ 'wrap-lines': wrap }" @pointercancel.capture="commentDragging = false">
            <p v-if="file.binary" class="empty">{{ t('binaryFile') }}</p><p v-else-if="!parsed.get(file.path)?.length" class="empty">{{ t('noTextDiff') }}</p>
            <SplitDiff v-else-if="split" :key="file.contextId" :path="file.path" :lines="parsed.get(file.path) || []" :threads="threads" :wrap="wrap" @expand="expandGap(file, $event.key, $event.direction)" @changed="loadThreads" @error="error = $event" @open-file="openFile($event)" />
            <div v-else class="unified-lines">
              <template v-for="(line, index) in parsed.get(file.path)" :key="line.key">
                <template v-if="!hiddenFold(index, diffFolds.get(file.contextId) || new Map(), start => closedDiffFolds.get(file.contextId)?.has((parsed.get(file.path) || [])[start].key) ?? false)">
                <div :class="['code-row', line.kind, { 'range-selected': selectedComment(file.path, line.oldLine, 'old') || selectedComment(file.path, line.newLine, 'new') }]" :data-comment-path="file.path" :data-old-line="line.oldLine" :data-new-line="line.newLine">
                  <ContextGap v-if="line.kind === 'gap'" :busy="loadingContext.has(file.contextId)" @expand="expandGap(file, line.key, $event)" />
                  <template v-else-if="line.kind === 'hunk' || line.kind === 'meta'"><span class="gutter"></span><code>{{ line.text }}</code></template>
                  <template v-else>
                    <button v-if="diffFolds.get(file.contextId)?.has(index)" type="button" class="fold-toggle" :aria-expanded="!closedDiffFolds.get(file.contextId)?.has(line.key)" :aria-label="t(closedDiffFolds.get(file.contextId)?.has(line.key) ? 'expandFold' : 'collapseFold', { line: line.newLine ?? line.oldLine ?? 0 })" @click="toggleDiffFold(file.contextId, line.key)">{{ closedDiffFolds.get(file.contextId)?.has(line.key) ? '▸' : '▾' }}</button><span v-else class="fold-spacer"></span>
                    <button class="line-number comment-trigger" data-comment-side="old" :aria-label="line.oldLine ? t('commentOnOldLine', { line: line.oldLine }) : t('noOldLine')" :disabled="line.oldLine === undefined" :aria-pressed="selectedComment(file.path, line.oldLine, 'old')" title="Click to comment; Shift-click or drag to select a range" @pointerdown="startCommentDrag($event, file.path, line.oldLine, 'old')" @pointermove="moveCommentDrag" @pointerup="endCommentDrag" @pointercancel="commentDrag = null" @click="line.oldLine !== undefined && beginComment(file.path, line.oldLine, 'old', $event)">{{ line.oldLine }}</button>
                    <button class="line-number comment-trigger" data-comment-side="new" :aria-label="line.newLine ? t('commentOnNewLine', { line: line.newLine }) : t('noNewLine')" :disabled="line.newLine === undefined" :aria-pressed="selectedComment(file.path, line.newLine, 'new')" title="Click to comment; Shift-click or drag to select a range" @pointerdown="startCommentDrag($event, file.path, line.newLine, 'new')" @pointermove="moveCommentDrag" @pointerup="endCommentDrag" @pointercancel="commentDrag = null" @click="line.newLine !== undefined && beginComment(file.path, line.newLine, 'new', $event)">{{ line.newLine }}</button>
                    <span class="sign">{{ line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ' ' }}</span><CodeText :path="file.path" :text="line.text" />
                  </template>
                </div>
                <div v-if="closedDiffFolds.get(file.contextId)?.has(line.key) && diffFolds.get(file.contextId)?.has(index)" class="fold-summary">{{ t('hiddenFoldLines', { count: diffFolds.get(file.contextId)!.get(index)! - index }) }}</div>
                <div class="line-threads"><ThreadView v-for="(thread, index) in lineThreads(file.path, line)" :key="thread.id" :thread="thread" :style="{ '--thread-index': index }" compact @changed="loadThreads" @error="error = $event" @open-file="openFile($event)" /></div>
                <form v-if="isComposer(file.path, line)" class="composer" @submit.prevent="saveComment()"><textarea v-focus v-model="comment" :aria-label="t('newComment')" :placeholder="t('writeComment')" rows="3"></textarea><div class="actions"><button class="primary" :disabled="busy || !comment.trim()">{{ t('addToReview') }}</button><button type="button" :disabled="busy || !comment.trim()" @click="saveComment(true)">{{ t('sendNow') }}</button><button type="button" :disabled="busy" @click="composer = null">{{ t('cancel') }}</button></div></form>
                </template>
              </template>
            </div>
          </div>
        </section>
        <section v-if="orphanedThreads.length" class="file-card">
          <div class="file-header"><strong>{{ t('outdatedDiscussions') }}</strong></div>
          <ThreadView v-for="thread in orphanedThreads" :key="thread.id" :thread="thread" show-location @changed="loadThreads" @error="error = $event" @open-file="openFile($event)" />
        </section>
        </template>
        <section v-if="view === 'discussions'" id="discussions" class="discussions"><h2>{{ t('discussions') }} <span class="count">{{ threads.length }}</span></h2><p class="muted">{{ t('discussionsDescription') }}</p><button v-if="!composingGeneral" @click="composingGeneral = true">{{ t('newDiscussion') }}</button><form v-else class="composer general-composer" @submit.prevent="saveGeneralComment()"><textarea v-model="generalComment" :aria-label="t('newDiscussion')" :placeholder="t('writeComment')" rows="3" autofocus></textarea><div class="actions"><button class="primary" :disabled="busy || !generalComment.trim()">{{ t('addToReview') }}</button><button type="button" :disabled="busy || !generalComment.trim()" @click="saveGeneralComment(true)">{{ t('sendNow') }}</button><button type="button" :disabled="busy" @click="composingGeneral = false">{{ t('cancel') }}</button></div></form><p v-if="!threads.length" class="muted">{{ t('noDiscussions') }}</p><div v-for="thread in threads" :key="thread.id" class="discussion-item"><div v-if="!thread.path" class="discussion-location">{{ t('generalDiscussion') }}</div><ThreadView :thread="thread" @changed="loadThreads" @error="error = $event" @open-file="openFile($event)" /></div></section>
      </div>
    </div>
  </main><main v-else class="closed"><h1>{{ t('reviewClosed') }}</h1><p>{{ t('closeTab') }}</p></main>
</template>
