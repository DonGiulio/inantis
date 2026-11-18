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

for (const [name, language] of Object.entries({ javascript, typescript, python, ruby, json, xml, css, bash, go, rust, java, sql })) hljs.registerLanguage(name, language)
const props = defineProps<{ text: string; path: string }>()
const extensions: Record<string, string> = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', json: 'json', html: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', css: 'css', sh: 'bash', bash: 'bash', go: 'go', rs: 'rust', java: 'java', sql: 'sql' }
const highlighted = computed(() => {
  const extension = props.path.split('.').pop()?.toLowerCase() || ''
  const language = extensions[extension]
  return language ? hljs.highlight(props.text, { language, ignoreIllegals: true }).value : null
})
</script>
<template><code v-if="highlighted !== null" v-html="highlighted"></code><code v-else>{{ text }}</code></template>
