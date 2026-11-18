<script setup lang="ts">
import { onMounted, ref } from 'vue'

type IgnoreStatus = { path: string; ignored: boolean; tracked: boolean }
const status = ref<IgnoreStatus | null>(null)
const error = ref(false)

onMounted(async () => {
  try {
    const response = await fetch('/api/review/ignore-status')
    if (!response.ok) throw new Error('Unable to check ignore status')
    const data: unknown = await response.json()
    if (!data || typeof data !== 'object' || !('path' in data) || typeof data.path !== 'string' || !('ignored' in data) || typeof data.ignored !== 'boolean' || !('tracked' in data) || typeof data.tracked !== 'boolean') throw new Error('Invalid ignore status')
    status.value = { path: data.path, ignored: data.ignored, tracked: data.tracked }
  } catch {
    error.value = true
  }
})
</script>

<template>
  <aside v-if="error || (status && (!status.ignored || status.tracked))" class="stale-warning" role="status">
    <template v-if="error">Could not check whether the published review Markdown is ignored by Git.</template>
    <template v-else-if="status?.tracked">
      Published review Markdown <code>{{ status.path }}</code> is tracked by Git. Ignore rules do not protect tracked files; remove it from the Git index if it should stay private.
    </template>
    <template v-else-if="status">
      Published review Markdown <code>{{ status.path }}</code> is not ignored by Git and may be included in a commit. Add an appropriate rule to your Git ignore configuration if it should stay private.
    </template>
  </aside>
</template>
