<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from './i18n'
import CodeText from './CodeText.vue'
import ThreadView from './ThreadView.vue'
import ContextGap from './ContextGap.vue'
import { findFolds } from './folding'
import type { ChangeRange } from './inline-diff'
import type { DiffLine, Thread } from './types'

const props = defineProps<{ path: string; lines: DiffLine[]; threads: Thread[]; wrap?: boolean; inlineChanges?: Map<string, ChangeRange[]> }>()
const emit = defineEmits<{ changed: []; error: [message: string]; openFile: [path: string]; expand: [value: { key: string; direction: 'top' | 'bottom' | 'all' }] }>()
type Row = { key: string; header?: DiffLine; old?: DiffLine; new?: DiffLine }
const rows = computed<Row[]>(() => {
  const result: Row[] = []
  const lines = props.lines
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    if (line.kind === 'deletion' || line.kind === 'addition') {
      const old: DiffLine[] = [], added: DiffLine[] = []
      while (i < lines.length && (lines[i].kind === 'deletion' || lines[i].kind === 'addition')) {
        const item = lines[i++]
        ;(item.kind === 'deletion' ? old : added).push(item)
      }
      for (let n = 0; n < Math.max(old.length, added.length); n++) result.push({ key: `${line.key}-${n}`, old: old[n], new: added[n] })
    } else {
      result.push(line.kind === 'context' ? { key: line.key, old: line, new: line } : { key: line.key, header: line })
      i++
    }
  }
  return result
})
const closedFolds = ref(new Set<string>())
const folds = computed(() => {
  const result = new Map<number, number>()
  const list = rows.value
  const sideFor = (row: Row) => row.header ? null : row.old && row.new ? (row.old === row.new ? 'context' : null) : row.old ? 'old' : row.new ? 'new' : null
  for (let start = 0; start < list.length;) {
    const side = sideFor(list[start])
    if (!side) { start++; continue }
    const lineFor = (row: Row) => side === 'new' ? row.new! : row.old!
    let end = start + 1
    while (end < list.length && sideFor(list[end]) === side &&
      (side === 'new' || lineFor(list[end]).oldLine === (lineFor(list[end - 1]).oldLine ?? 0) + 1) &&
      (side === 'old' || lineFor(list[end]).newLine === (lineFor(list[end - 1]).newLine ?? 0) + 1)) end++
    for (const [first, last] of findFolds(list.slice(start, end).map(row => lineFor(row).text), props.path)) result.set(start + first, start + last)
    start = end
  }
  // A replacement may pair the opening line with an old line while the
  // remainder exists only on one side. Keep the paired row visible.
  for (let start = 0; start < list.length; start++) {
    const first = list[start]
    if (!first.old || !first.new || first.old === first.new) continue
    for (const side of ['old', 'new'] as const) {
      const other = side === 'old' ? 'new' : 'old'
      const number = side === 'old' ? 'oldLine' : 'newLine'
      const text = [first[side]!.text]
      let end = start + 1
      let previous = first[side]![number]
      while (end < list.length && list[end][side] && !list[end][other] &&
        list[end][side]![number] === (previous ?? 0) + 1) {
        previous = list[end][side]![number]
        text.push(list[end][side]!.text)
        end++
      }
      const last = findFolds(text, props.path).get(0)
      if (last !== undefined) { result.set(start, start + last); break }
    }
  }
  return result
})
function hidden(index: number) {
  for (const [start, end] of folds.value) if (start < index && index <= end && closedFolds.value.has(rows.value[start].key)) return true
  return false
}
function toggleFold(key: string) {
  if (closedFolds.value.has(key)) closedFolds.value.delete(key); else closedFolds.value.add(key)
}
watch(() => props.path, () => { closedFolds.value = new Set() })
const view = ref<HTMLElement | null>(null)
const scrollbar = ref<HTMLElement | null>(null)
const scrollOffset = ref(0)
const scrollRange = ref(0)
let observer: ResizeObserver | undefined

function measureOverflow() {
  if (!view.value || props.wrap) {
    scrollRange.value = 0
    scrollOffset.value = 0
    return
  }
  let range = 0
  for (const code of view.value.querySelectorAll<HTMLElement>('.split-cell code')) {
    const cell = code.parentElement!
    const available = cell.clientWidth - (cell.children[0] as HTMLElement).offsetWidth - (cell.children[1] as HTMLElement).offsetWidth
    range = Math.max(range, code.scrollWidth - available)
  }
  scrollRange.value = Math.max(0, range)
  if (scrollbar.value) scrollOffset.value = scrollbar.value.scrollLeft
}

async function observeContent() {
  await nextTick()
  observer?.disconnect()
  if (view.value) {
    observer?.observe(view.value)
    for (const code of view.value.querySelectorAll<HTMLElement>('.split-cell code')) observer?.observe(code)
  }
  measureOverflow()
}

function scrollOnWheel(event: WheelEvent) {
  const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0)
  if (!delta || !scrollbar.value) return
  const previous = scrollbar.value.scrollLeft
  scrollbar.value.scrollLeft += delta
  if (scrollbar.value.scrollLeft !== previous) {
    scrollOffset.value = scrollbar.value.scrollLeft
    event.preventDefault()
  }
}

onMounted(() => {
  observer = new ResizeObserver(measureOverflow)
  observeContent()
})
onBeforeUnmount(() => observer?.disconnect())
watch(() => [rows.value, props.wrap], observeContent, { flush: 'post' })
type Side = 'old' | 'new'
const composer = ref<{ line: number; startLine?: number; side: Side } | null>(null)
const vFocus = { mounted(element: HTMLTextAreaElement) { element.focus() } }
const selectionAnchor = ref<number | null>(null)
const body = ref('')
const busy = ref(false)
let drag: { pointerId: number; side: Side; start: number; end: number; moved: boolean } | null = null
const draggingRange = ref(false)
let suppressClick = false

function selectRange(start: number, end: number, side: Side) {
  const first = Math.min(start, end), last = Math.max(start, end)
  composer.value = { line: last, ...(first !== last ? { startLine: first } : {}), side }
  selectionAnchor.value = start
}

function begin(line: number | undefined, side: Side, event: MouseEvent) {
  if (suppressClick) { suppressClick = false; return }
  if (line === undefined) return
  if (event.shiftKey && composer.value?.side === side && selectionAnchor.value !== null) {
    selectRange(selectionAnchor.value, line, side)
    return
  }
  if (composer.value?.line === line && composer.value.side === side) {
    composer.value = null; selectionAnchor.value = null; body.value = ''; return
  }
  selectRange(line, line, side); body.value = ''
}

function startDrag(event: PointerEvent, line: number | undefined, side: Side) {
  if (event.button !== 0 || event.shiftKey || line === undefined) return
  drag = { pointerId: event.pointerId, side, start: line, end: line, moved: false }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function moveDrag(event: PointerEvent) {
  if (!drag || drag.pointerId !== event.pointerId) return
  const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.split-cell[data-line]')
  if (!cell || cell.dataset.side !== drag.side) return
  const line = Number(cell.dataset.line)
  if (!Number.isSafeInteger(line) || line < 1) return
  drag.end = line
  if (line !== drag.start) drag.moved = true
  if (drag.moved) { draggingRange.value = true; selectRange(drag.start, line, drag.side); event.preventDefault() }
}

function endDrag(event: PointerEvent) {
  if (!drag || drag.pointerId !== event.pointerId) return
  if (drag.moved) {
    selectRange(drag.start, drag.end, drag.side)
    suppressClick = true
    setTimeout(() => { suppressClick = false }, 0)
  }
  draggingRange.value = false
  drag = null
}

function selected(line: number | undefined, side: Side) {
  return line !== undefined && composer.value?.side === side && line >= (composer.value.startLine ?? composer.value.line) && line <= composer.value.line
}
function matches(row: Row) {
  return props.threads.filter(thread => thread.path === props.path && (thread.side === 'old' ? row.old?.oldLine === thread.line : row.new?.newLine === thread.line))
}
function composing(row: Row) {
  return !draggingRange.value && composer.value && (composer.value.side === 'old' ? row.old?.oldLine === composer.value.line : row.new?.newLine === composer.value.line)
}
async function save(published = false) {
  if (busy.value || !composer.value || !body.value.trim()) return
  busy.value = true
  try {
    const response = await fetch('/api/threads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: props.path, ...composer.value, body: body.value, published }) })
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || t('httpError', { status: response.status })) }
    composer.value = null; body.value = ''; emit('changed')
  } catch (e) { emit('error', e instanceof Error ? e.message : String(e)) }
  finally { busy.value = false }
}
</script>
<template>
  <div ref="view" :class="['split-view', { 'wrap-lines': wrap }]" :style="{ '--split-offset': `${scrollOffset}px` }" @wheel="scrollOnWheel" @pointercancel.capture="draggingRange = false">
    <template v-for="(row, index) in rows" :key="row.key">
      <template v-if="!hidden(index)">
      <div v-if="row.header" :class="['split-header', row.header.kind]"><ContextGap v-if="row.header.kind === 'gap'" @expand="emit('expand', { key: row.header!.key, direction: $event })" /><template v-else>{{ row.header.text }}</template></div>
      <div v-else class="split-row">
        <button v-if="folds.has(index)" type="button" class="fold-toggle split-fold-toggle" :aria-expanded="!closedFolds.has(row.key)" :aria-label="t(closedFolds.has(row.key) ? 'expandFold' : 'collapseFold', { line: row.new?.newLine ?? row.old?.oldLine ?? 0 })" @click="toggleFold(row.key)">{{ closedFolds.has(row.key) ? '▸' : '▾' }}</button>
        <div :class="['split-cell', row.old?.kind || 'blank', { 'range-selected': selected(row.old?.oldLine, 'old') }]" data-side="old" :data-line="row.old?.oldLine"><button class="line-number comment-trigger" :disabled="row.old?.oldLine === undefined" :aria-label="row.old?.oldLine === undefined ? t('noOldLine') : t('commentOnOldLine', { line: row.old.oldLine })" :aria-pressed="selected(row.old?.oldLine, 'old')" title="Click to comment; Shift-click or drag to select a range" @pointerdown="startDrag($event, row.old?.oldLine, 'old')" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="drag = null" @click="begin(row.old?.oldLine, 'old', $event)">{{ row.old?.oldLine }}</button><span class="sign">{{ row.old?.kind === 'deletion' ? '−' : '' }}</span><CodeText v-if="row.old" :path="path" :text="row.old.text" :changes="inlineChanges?.get(row.old.key)" /></div>
        <div :class="['split-cell', row.new?.kind || 'blank', { 'range-selected': selected(row.new?.newLine, 'new') }]" data-side="new" :data-line="row.new?.newLine"><button class="line-number comment-trigger" :disabled="row.new?.newLine === undefined" :aria-label="row.new?.newLine === undefined ? t('noNewLine') : t('commentOnNewLine', { line: row.new.newLine })" :aria-pressed="selected(row.new?.newLine, 'new')" title="Click to comment; Shift-click or drag to select a range" @pointerdown="startDrag($event, row.new?.newLine, 'new')" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="drag = null" @click="begin(row.new?.newLine, 'new', $event)">{{ row.new?.newLine }}</button><span class="sign">{{ row.new?.kind === 'addition' ? '+' : '' }}</span><CodeText v-if="row.new" :path="path" :text="row.new.text" :changes="inlineChanges?.get(row.new.key)" /></div>
      </div>
      <div v-if="closedFolds.has(row.key) && folds.has(index)" class="fold-summary">{{ t('hiddenFoldLines', { count: folds.get(index)! - index }) }}</div>
      <div class="split-threads">
        <div v-for="side in (['old', 'new'] as const)" :key="side" class="line-threads">
          <ThreadView v-for="(thread, index) in matches(row).filter(thread => thread.side === side)" :key="thread.id" :thread="thread" :style="{ '--thread-index': index }" compact @changed="emit('changed')" @error="emit('error', $event)" @open-file="emit('openFile', $event)" />
        </div>
      </div>
      <form v-if="composing(row)" class="composer" @submit.prevent="save()"><textarea v-focus v-model="body" :aria-label="t('newComment')" :placeholder="t('writeComment')" rows="3"></textarea><div class="actions"><button class="primary" :disabled="busy || !body.trim()">{{ t('addToReview') }}</button><button type="button" :disabled="busy || !body.trim()" @click="save(true)">{{ t('sendNow') }}</button><button type="button" :disabled="busy" @click="composer = null">{{ t('cancel') }}</button></div></form>
      </template>
    </template>
    <div v-if="!wrap" ref="scrollbar" class="split-scrollbar" @scroll="scrollOffset = ($event.target as HTMLElement).scrollLeft"><div :style="{ width: `calc(100% + ${scrollRange}px)` }"></div></div>
  </div>
</template>
