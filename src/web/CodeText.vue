<script setup lang="ts">
import { computed } from 'vue'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import bash from 'highlight.js/lib/languages/bash'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import java from 'highlight.js/lib/languages/java'
import sql from 'highlight.js/lib/languages/sql'
import type { ChangeRange } from './inline-diff'

for (const [name, language] of Object.entries({ javascript, typescript, python, ruby, json, xml, css, bash, go, rust, java, sql })) hljs.registerLanguage(name, language)
const props = defineProps<{ text: string; path: string; changes?: ChangeRange[] }>()
const extensions: Record<string, string> = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', json: 'json', html: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', css: 'css', sh: 'bash', bash: 'bash', go: 'go', rs: 'rust', java: 'java', sql: 'sql' }
const highlighted = computed(() => {
  const extension = props.path.split('.').pop()?.toLowerCase() || ''
  const language = extensions[extension]
  return language ? hljs.highlight(props.text, { language, ignoreIllegals: true }).value : null
})
const marked = computed(() => {
  if (!props.changes?.length) return highlighted.value
  const container = document.createElement('div')
  if (highlighted.value === null) container.textContent = props.text
  else container.innerHTML = highlighted.value
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  let offset = 0
  for (const node of nodes) {
    const text = node.data, end = offset + text.length
    const fragment = document.createDocumentFragment()
    let position = 0
    for (const change of props.changes) {
      const start = Math.max(change.start, offset) - offset
      const stop = Math.min(change.end, end) - offset
      if (start >= stop) continue
      fragment.append(document.createTextNode(text.slice(position, start)))
      const mark = document.createElement('mark')
      mark.className = 'inline-change'
      mark.textContent = text.slice(start, stop)
      fragment.append(mark)
      position = stop
    }
    fragment.append(document.createTextNode(text.slice(position)))
    node.replaceWith(fragment)
    offset = end
  }
  return container.innerHTML
})
const html = computed(() => props.changes?.length ? marked.value : highlighted.value)
</script>
<template><code v-if="html !== null" v-html="html"></code><code v-else>{{ text }}</code></template>
