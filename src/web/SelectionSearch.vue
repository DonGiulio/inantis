<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  labels?: { previous: string; next: string; count: string }
}>(), {
  labels: () => ({ previous: 'Previous occurrence', next: 'Next occurrence', count: '{current} of {total}' }),
})

const selector = '.code-row:not(.hunk):not(.meta) > code, .split-cell > code'
const host = ref<HTMLElement | null>(null)
const query = ref('')
const emit = defineEmits<{ selection: [text: string] }>()
watch(query, text => emit('selection', text))
const current = ref(0)
const total = ref(0)
const rectangles = ref<{ left: number; top: number; width: number; height: number; active: boolean }[]>([])
let matches: Range[][] = []
let observer: MutationObserver | undefined
let selectedCode: HTMLElement | null = null
let frame = 0

function codeFor(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement
  return element?.closest<HTMLElement>(selector) ?? null
}

function rangeAt(nodes: Text[], start: number, end: number): Range | null {
  let offset = 0
  let first: Text | undefined
  let last: Text | undefined
  let firstOffset = 0
  let lastOffset = 0
  for (const node of nodes) {
    const next = offset + node.length
    if (!first && start < next) { first = node; firstOffset = start - offset }
    if (first && end <= next) { last = node; lastOffset = end - offset; break }
    offset = next
  }
  if (!first || !last) return null
  const range = document.createRange()
  range.setStart(first, firstOffset)
  range.setEnd(last, lastOffset)
  return range
}

function codeGroups(): HTMLElement[][] {
  const groups: HTMLElement[][] = []
  for (const file of document.querySelectorAll<HTMLElement>('.file-card')) {
    let active: HTMLElement[][] = [[], []]
    let numbers: (number | null)[] = [null, null]
    function flush(side: number) {
      if (active[side].length) groups.push(active[side])
      active[side] = []
      numbers[side] = null
    }
    for (const row of file.querySelectorAll<HTMLElement>('.code-row, .split-row, .split-header')) {
      if (row.matches('.hunk, .meta, .gap, .split-header')) {
        flush(0); flush(1)
        continue
      }
      const cells = row.matches('.split-row')
        ? Array.from(row.querySelectorAll<HTMLElement>(':scope > .split-cell'))
        : [row]
      const unified = cells.length === 1
      const codes = cells.map(cell => cell.querySelector<HTMLElement>(':scope > code'))
      const buttons = unified ? row.querySelectorAll<HTMLElement>(':scope > .line-number') : null
      for (let side = 0; side < 2; side++) {
        const cell = unified ? row : cells[side]
        const code = unified ? codes[0] : codes[side]
        const button = unified ? buttons?.[buttons.length === 1 ? (side === 0 ? 0 : 1) : side] : cell?.querySelector<HTMLElement>(':scope > .line-number')
        const number = Number(button?.textContent?.trim())
        if (!code || !button || !number) continue
        if (numbers[side] !== null && number !== numbers[side]! + 1) flush(side)
        active[side].push(code)
        numbers[side] = number
      }
    }
    flush(0); flush(1)
  }
  return groups
}

function lineRanges(code: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  return rangeAt(nodes, start, end)
}

function findMatches() {
  const previous = matches[current.value]?.[0]
  const found: Range[][] = []
  let selected = -1
  const selection = document.getSelection()
  const selectionRange = selection?.rangeCount ? selection.getRangeAt(0) : null
  if (query.value) {
    for (const group of codeGroups()) {
      const lines = group.map(code => code.textContent ?? '')
      const text = lines.join('\n')
      for (let offset = 0; offset <= text.length - query.value.length;) {
        const index = text.indexOf(query.value, offset)
        if (index < 0) break
        const ranges: Range[] = []
        let position = 0
        for (let i = 0; i < lines.length; i++) {
          const start = Math.max(0, index - position)
          const end = Math.min(lines[i].length, index + query.value.length - position)
          if (end > start) {
            const range = lineRanges(group[i], start, end)
            if (range) ranges.push(range)
          }
          position += lines[i].length + 1
          if (position > index + query.value.length) break
        }
        const first = ranges[0]
        if (first && !found.some(item => item.length === ranges.length && item.every((part, i) => part.startContainer === ranges[i].startContainer && part.startOffset === ranges[i].startOffset && part.endContainer === ranges[i].endContainer && part.endOffset === ranges[i].endOffset))) {
          if (selectionRange && first.compareBoundaryPoints(Range.START_TO_START, selectionRange) === 0) selected = found.length
          else if (selected < 0 && first.startContainer === previous?.startContainer && first.startOffset === previous.startOffset) selected = found.length
          found.push(ranges)
        }
        offset = index + query.value.length
      }
    }
  }
  const selectedMatch = found[selected]
  found.sort((a, b) => a[0].compareBoundaryPoints(Range.START_TO_START, b[0]))
  matches = found
  total.value = found.length
  current.value = selectedMatch ? found.indexOf(selectedMatch) : Math.min(current.value, Math.max(0, found.length - 1))
}

function draw() {
  frame = 0
  const result: typeof rectangles.value = []
  matches.forEach((ranges, index) => ranges.forEach(range => {
    const code = codeFor(range.startContainer)
    if (!code?.isConnected) return
    for (const rect of range.getClientRects()) {
      let left = Math.max(0, rect.left), top = Math.max(0, rect.top)
      let right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom)
      for (let parent: HTMLElement | null = code.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        const clipX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX)
        const clipY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY)
        if (clipX || clipY) {
          const bounds = parent.getBoundingClientRect()
          if (clipX) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right) }
          if (clipY) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom) }
        }
      }
      const cell = code.closest<HTMLElement>('.split-cell')
      if (cell && !cell.closest('.wrap-lines')) {
        const bounds = cell.getBoundingClientRect()
        const gutter = (cell.children[0] as HTMLElement).offsetWidth + (cell.children[1] as HTMLElement).offsetWidth
        left = Math.max(left, bounds.left + gutter)
      }
      if (right > left && bottom > top) result.push({ left, top, width: right - left, height: bottom - top, active: index === current.value })
    }
  }))
  rectangles.value = result
}

function schedule(scan = false) {
  if (scan) findMatches()
  if (!frame) frame = requestAnimationFrame(draw)
}

function selectionChanged() {
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    if (!selectedCode || selectedCode.isConnected) query.value = ''
    selectedCode = null
    schedule(true)
    return
  }
  const range = selection.getRangeAt(0)
  const start = codeFor(range.startContainer)
  const end = codeFor(range.endContainer)
  const group = start && end ? codeGroups().find(lines => lines.includes(start) && lines.indexOf(end) >= lines.indexOf(start)) : undefined
  selectedCode = group ? start : null
  if (group && start && end) {
    const first = group.indexOf(start), last = group.indexOf(end)
    const prefix = document.createRange()
    prefix.selectNodeContents(start)
    prefix.setEnd(range.startContainer, range.startOffset)
    const suffix = document.createRange()
    suffix.selectNodeContents(end)
    suffix.setEnd(range.endContainer, range.endOffset)
    const lines = group.slice(first, last + 1).map(code => code.textContent ?? '')
    if (first === last) query.value = lines[0].slice(prefix.toString().length, suffix.toString().length)
    else {
      lines[0] = lines[0].slice(prefix.toString().length)
      lines[lines.length - 1] = lines[lines.length - 1].slice(0, suffix.toString().length)
      query.value = lines.join('\n')
    }
  } else query.value = ''
  current.value = 0
  schedule(true)
}

function navigate(direction: number) {
  if (!matches.length) return
  current.value = (current.value + direction + matches.length) % matches.length
  const range = matches[current.value][0]
  const code = codeFor(range.startContainer)
  if (!code) return
  code.scrollIntoView({ block: 'center', inline: 'nearest' })
  const rect = range.getBoundingClientRect()
  const cell = code.closest<HTMLElement>('.split-cell')
  const scrollbar = cell?.closest('.split-view')?.querySelector<HTMLElement>('.split-scrollbar')
  if (cell && scrollbar) {
    const bounds = cell.getBoundingClientRect()
    const gutter = (cell.children[0] as HTMLElement).offsetWidth + (cell.children[1] as HTMLElement).offsetWidth
    if (rect.left < bounds.left + gutter) scrollbar.scrollLeft -= bounds.left + gutter - rect.left
    else if (rect.right > bounds.right) scrollbar.scrollLeft += rect.right - bounds.right
  } else {
    for (let parent = code.parentElement; parent; parent = parent.parentElement) {
      if (parent.scrollWidth <= parent.clientWidth) continue
      const bounds = parent.getBoundingClientRect()
      if (rect.left < bounds.left) parent.scrollLeft -= bounds.left - rect.left
      else if (rect.right > bounds.right) parent.scrollLeft += rect.right - bounds.right
    }
  }
  schedule()
}

function onScroll() { schedule() }
function onResize() { schedule() }

onMounted(() => {
  document.addEventListener('selectionchange', selectionChanged)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onResize)
  observer = new MutationObserver(records => {
    if (records.some(record => !host.value?.contains(record.target))) schedule(true)
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  selectionChanged()
})

onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', selectionChanged)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', onResize)
  observer?.disconnect()
  if (frame) cancelAnimationFrame(frame)
})
</script>

<template>
  <div ref="host" class="selection-search">
    <div v-for="(rect, index) in rectangles" :key="index" class="selection-mark" :class="{ active: rect.active }" :style="{ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }" aria-hidden="true"></div>
    <div v-if="total" class="selection-controls" role="group" aria-label="Selection occurrences" @mousedown.prevent>
      <span aria-live="polite">{{ props.labels.count.replace('{current}', String(current + 1)).replace('{total}', String(total)) }}</span>
      <button type="button" :aria-label="props.labels.previous" :title="props.labels.previous" @click="navigate(-1)">↑</button>
      <button type="button" :aria-label="props.labels.next" :title="props.labels.next" @click="navigate(1)">↓</button>
    </div>
  </div>
</template>

<style scoped>
.selection-mark { position: fixed; z-index: 20; pointer-events: none; background: rgba(255, 203, 50, .35); border-radius: 2px; }
.selection-mark.active { background: rgba(255, 145, 0, .5); outline: 1px solid rgba(180, 95, 0, .8); }
.selection-controls { position: fixed; right: 1rem; bottom: 1rem; z-index: 21; display: flex; align-items: center; gap: .35rem; padding: .4rem .55rem; border: 1px solid #999; border-radius: .4rem; background: Canvas; color: CanvasText; box-shadow: 0 2px 8px #0003; }
.selection-controls button { min-width: 2rem; min-height: 2rem; cursor: pointer; }
</style>
