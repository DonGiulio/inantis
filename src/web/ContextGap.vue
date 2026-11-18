<script setup lang="ts">
defineProps<{ busy?: boolean }>()
const emit = defineEmits<{ expand: [direction: 'top' | 'bottom' | 'all'] }>()
</script>
<template>
  <span class="context-controls">
    <button type="button" :disabled="busy" aria-label="Expand next 20 lines" title="Expand next 20 lines" @click="emit('expand', 'top')">↓ 20</button>
    <button type="button" :disabled="busy" aria-label="Expand previous 20 lines" title="Expand previous 20 lines" @click="emit('expand', 'bottom')">↑ 20</button>
    <button type="button" :disabled="busy" aria-label="Expand all hidden lines" title="Expand all hidden lines" @click="emit('expand', 'all')">↕ All</button>
  </span>
</template>
<style scoped>
.context-controls{display:inline-flex;gap:4px;padding:2px 8px;user-select:none}.context-controls button{border:0;border-radius:3px;background:transparent;color:#4c4c80;padding:2px 6px;font:12px/20px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.context-controls button:hover{background:#ded6f1}
</style>
