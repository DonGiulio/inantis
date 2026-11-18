<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { t } from './i18n'

const emit = defineEmits<{ close: [] }>()
const step = ref(0)
const position = ref({ top: 16, left: 16 })
let highlighted: Element | null = null
const steps = [
  { target: '.comparison', title: 'tourCompareTitle', body: 'tourCompareBody' },
  { target: '.sidebar-title', title: 'tourFilesTitle', body: 'tourFilesBody' },
  { target: '.content', title: 'tourCommentsTitle', body: 'tourCommentsBody' },
  { target: '.tabs button:nth-child(2)', title: 'tourRepliesTitle', body: 'tourRepliesBody' },
] as const

function place() {
  const target = document.querySelector(steps[step.value].target) ?? document.querySelector('.tabs')
  if (!target) return
  if (highlighted !== target) {
    highlighted?.classList.remove('walkthrough-target')
    target.classList.add('walkthrough-target')
    highlighted = target
  }
  const rect = target.getBoundingClientRect()
  const width = Math.min(340, window.innerWidth - 32)
  position.value = {
    left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)),
    top: Math.max(16, Math.min(rect.bottom + 10, window.innerHeight - 230)),
  }
}
watch(step, async () => { await nextTick(); place() })
function keydown(event: KeyboardEvent) { if (event.key === 'Escape') emit('close') }
onMounted(() => { place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true); window.addEventListener('keydown', keydown) })
onUnmounted(() => { highlighted?.classList.remove('walkthrough-target'); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); window.removeEventListener('keydown', keydown) })
</script>

<template>
  <section class="walkthrough" role="dialog" :aria-label="t(steps[step].title)" :style="{ top: `${position.top}px`, left: `${position.left}px` }">
    <div class="walkthrough-header"><span>{{ t('tourProgress', { current: step + 1, total: steps.length }) }}</span><button type="button" :aria-label="t('tourClose')" @click="emit('close')">×</button></div>
    <h2>{{ t(steps[step].title) }}</h2>
    <p>{{ t(steps[step].body) }}</p>
    <div class="walkthrough-actions">
      <button type="button" @click="emit('close')">{{ t('tourSkip') }}</button>
      <button v-if="step > 0" type="button" @click="step--">{{ t('tourBack') }}</button>
      <button v-if="step < steps.length - 1" type="button" class="primary" @click="step++">{{ t('tourNext') }}</button>
      <button v-else type="button" class="primary" @click="emit('close')">{{ t('tourDone') }}</button>
    </div>
  </section>
</template>
