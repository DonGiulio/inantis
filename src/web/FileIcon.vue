<script lang="ts">
const special: Record<string, string> = { dockerfile: 'docker', makefile: 'make', '.gitignore': 'git', '.gitattributes': 'git', '.env': 'env' }
const colors: Record<string, string> = {
  ts: '#3178c6', tsx: '#3178c6', js: '#bb8900', jsx: '#bb8900', mjs: '#bb8900', cjs: '#bb8900',
  vue: '#268b68', svelte: '#d65a31', html: '#db6239', css: '#327dc2', scss: '#bd5f92',
  json: '#bb8900', yaml: '#a7588c', yml: '#a7588c', toml: '#a7588c', xml: '#d67b2e',
  md: '#5177a0', mdx: '#5177a0', py: '#3572a5', rs: '#b05c38', go: '#168aa2', java: '#bd5745',
  c: '#5983af', cpp: '#5983af', h: '#8061ab', sh: '#5b8b60', bash: '#5b8b60',
  png: '#a159a6', jpg: '#a159a6', jpeg: '#a159a6', svg: '#a159a6', gif: '#a159a6', webp: '#a159a6',
  docker: '#318ac4', git: '#d55c41', env: '#9b8034', lock: '#8a7785',
}
</script>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ path?: string; directory?: boolean }>()
const icon = computed(() => {
  const name = (props.path || '').split('/').pop()!.toLowerCase()
  const extension = Object.hasOwn(special, name) ? special[name] : (name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.') + 1) : '')
  return { label: extension.slice(0, 4).toUpperCase(), color: Object.hasOwn(colors, extension) ? colors[extension] : '#7c8494' }
})
</script>

<template>
  <svg v-if="directory" class="file-type-icon folder-type-icon" viewBox="0 0 20 20" aria-hidden="true">
    <path fill="#d89d39" d="M2.2 4.1a1.4 1.4 0 0 1 1.4-1.4h4l1.6 1.8h7.2a1.4 1.4 0 0 1 1.4 1.4v1H2.2z" />
    <path fill="#edbb59" d="M2.1 7.1h15.8l-1.3 8.4a1.5 1.5 0 0 1-1.5 1.3H4.8a1.5 1.5 0 0 1-1.5-1.3z" />
  </svg>
  <svg v-else class="file-type-icon" viewBox="0 0 20 20" aria-hidden="true">
    <path :fill="icon.color" d="M4 1.5h7.5L16 6v11a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 3 17V3a1.5 1.5 0 0 1 1-1.5z" />
    <path fill="#fff" opacity=".45" d="M11.5 1.5V6H16z" />
    <text v-if="icon.label" x="9.5" y="14.5" text-anchor="middle" fill="#fff" :font-size="icon.label.length > 3 ? 5.2 : 6" font-weight="700" font-family="system-ui, sans-serif">{{ icon.label }}</text>
    <path v-else d="M6.5 10h6M6.5 13h6" fill="none" stroke="#fff" stroke-width="1.2" stroke-linecap="round" opacity=".9" />
  </svg>
</template>
