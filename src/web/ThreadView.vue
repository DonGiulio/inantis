<script setup lang="ts">
import { ref, watch } from 'vue'
import { t, formatDate } from './i18n'
import { renderMarkdown } from './markdown'
import type { Thread } from './types'

const props = defineProps<{ thread: Thread; compact?: boolean; showLocation?: boolean }>()
const emit = defineEmits<{ changed: []; error: [message: string]; openFile: [path: string] }>()
const reply = ref('')
const editing = ref<string | null>(null)
const editedBody = ref('')
const busy = ref(false)
const expanded = ref(false)
watch(() => props.thread.resolved, () => { expanded.value = false })

async function request(path: string, method: string, body?: unknown) {
  busy.value = true
  try {
    const response = await fetch(path, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.error || t('httpError', { status: response.status }))
    }
    emit('changed')
    return true
  } catch (error) {
    emit('error', error instanceof Error ? error.message : String(error))
    return false
  } finally { busy.value = false }
}
const base = () => `/api/threads/${encodeURIComponent(props.thread.id)}`
async function sendReply(published = false) {
  if (!busy.value && reply.value.trim() && await request(`${base()}/replies`, 'POST', { body: reply.value, published })) reply.value = ''
}
async function saveEdit(id: string) {
  if (editedBody.value.trim() && await request(`${base()}/messages/${encodeURIComponent(id)}`, 'PATCH', { body: editedBody.value })) editing.value = null
}
</script>

<template>
  <button v-if="compact && thread.resolved && !expanded" class="resolved-thread-icon" :aria-label="t('expandResolvedDiscussion')" :title="t('expandResolvedDiscussion')" @click="expanded = true">✓</button>
  <section v-else class="thread" :aria-label="!thread.path ? t('generalDiscussion') : thread.startLine !== undefined ? `Discussion on lines ${thread.startLine}–${thread.line}` : t('discussionOnLine', { line: thread.line ?? '' })">
    <div class="thread-heading">
      <span v-if="thread.startLine !== undefined">Lines {{ thread.startLine }}–{{ thread.line }}</span>
      <strong>{{ t('discussion') }} <span v-if="thread.resolved" class="resolved">{{ t('resolved') }}</span></strong>
      <button class="text-button" :disabled="busy" @click="request(`${base()}/resolve`, 'POST', { resolved: !thread.resolved })">{{ t(thread.resolved ? 'reopen' : 'resolve') }}</button>
      <button v-if="compact && thread.resolved" class="text-button" @click="expanded = false">{{ t('collapseDiscussion') }}</button>
    </div>
    <p v-if="thread.path" class="discussion-location"><button type="button" class="text-button" @click="emit('openFile', thread.path)">{{ thread.path }}</button><span v-if="thread.line !== null"> · {{ t(thread.side === 'old' ? 'oldLineLocation' : 'newLineLocation', { path: '', line: thread.line }).replace(' · ', '') }}</span></p>
    <p v-if="thread.stale" class="stale-warning">{{ t('staleWarning') }}</p>
    <article v-for="message in thread.messages" :key="message.id" class="message" :class="{ 'message-draft': !message.published }">
      <div class="message-meta"><strong>{{ t(message.author === 'agent' ? 'agent' : 'reviewer') }}</strong><span v-if="!message.published" class="badge">{{ t('draft') }}</span><time :datetime="message.createdAt">{{ formatDate(message.createdAt) }}</time></div>
      <template v-if="!message.published && editing === message.id">
        <textarea v-model="editedBody" :aria-label="t('editComment')" rows="3"></textarea>
        <div class="actions"><button class="primary" :disabled="busy || !editedBody.trim()" @click="saveEdit(message.id)">{{ t('save') }}</button><button @click="editing = null">{{ t('cancel') }}</button></div>
      </template>
      <template v-else>
        <div class="message-body markdown-body" v-html="renderMarkdown(message.body)"></div>
        <div v-if="!message.published" class="actions"><button class="text-button" :disabled="busy" @click="request(`${base()}/messages/${encodeURIComponent(message.id)}/publish`, 'POST')">{{ t('sendNow') }}</button><button class="text-button" @click="editing = message.id; editedBody = message.body">{{ t('edit') }}</button><button class="text-button danger" :disabled="busy" @click="request(`${base()}/messages/${encodeURIComponent(message.id)}`, 'DELETE')">{{ t('delete') }}</button></div>
      </template>
    </article>
    <form class="reply" @submit.prevent="sendReply()">
      <textarea v-model="reply" :aria-label="t('replyToDiscussion')" :placeholder="t('writeReply')" rows="2"></textarea>
      <div class="actions"><button class="primary" :disabled="busy || !reply.trim()">{{ t('addToReview') }}</button><button type="button" :disabled="busy || !reply.trim()" @click="sendReply(true)">{{ t('sendNow') }}</button><button type="button" :disabled="busy" @click="reply = ''">{{ t('cancel') }}</button></div>
    </form>
  </section>
</template>
