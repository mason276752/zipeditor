<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { baseName, readEntry, type FileEntry } from '../archive'
import { kindOf, looksLikeText, mimeOf, type Kind } from '../kinds'
import { fmtBytes, fmtDate } from '../util'
import { FILE_TOOLS, TOOLS, type FileKind, type Tool } from '../bridge'
import { ensureDecodable } from '../heif'
import Icon from './Icon.vue'

const props = defineProps<{ entry: FileEntry; canSend: boolean }>()
const emit = defineEmits<{
  close: []
  save: [blob: Blob]
  download: []
  rename: []
  remove: []
  send: [tool: Tool]
  dirty: [dirty: boolean]
}>()

const EDIT_LIMIT = 5 * 1024 * 1024

const name = computed(() => baseName(props.entry.path))
const kind = ref<Kind>('other')
const url = ref('')
const loading = ref(true)
const failed = ref('')
const dims = ref('')
const mediaError = ref(false)
const convertingHeif = ref(false)
const sendTargets = computed<Tool[]>(() => (kind.value in FILE_TOOLS ? FILE_TOOLS[kind.value as FileKind] : []))

// Text editing. The textarea only ever holds "\n"; CRLF files get theirs back on save.
const text = ref('')
const savedText = ref('')
const textMode = ref(false)
const notUtf8 = ref(false)
const tooBig = ref(false)
let crlf = false
let bom = false
let blob: Blob | null = null
let heifTried = false

const dirty = computed(() => textMode.value && text.value !== savedText.value)
watch(dirty, (d) => emit('dirty', d))

function revoke() {
  if (url.value) URL.revokeObjectURL(url.value)
  url.value = ''
}

async function openAsText(force = false) {
  if (!blob) return
  if (blob.size > EDIT_LIMIT && !force) {
    tooBig.value = true
    return
  }
  tooBig.value = false
  const bytes = new Uint8Array(await blob.arrayBuffer())
  bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  let raw: string
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    notUtf8.value = false
  } catch {
    raw = new TextDecoder('utf-8').decode(bytes)
    notUtf8.value = true
  }
  crlf = raw.includes('\r\n')
  text.value = savedText.value = raw.replace(/\r\n/g, '\n')
  textMode.value = true
}

async function load() {
  const entry = props.entry
  revoke()
  loading.value = true
  failed.value = ''
  dims.value = ''
  mediaError.value = false
  convertingHeif.value = false
  heifTried = false
  textMode.value = false
  tooBig.value = false
  notUtf8.value = false
  try {
    const b = await readEntry(entry)
    if (entry !== props.entry) return // switched files meanwhile
    blob = b
    let k = kindOf(entry.path)
    if (k === 'other' && (await looksLikeText(b))) k = 'text'
    kind.value = k
    if (k === 'text') await openAsText()
    else if (k !== 'other') url.value = URL.createObjectURL(new Blob([b], { type: mimeOf(entry.path) }))
  } catch (err) {
    console.warn('read failed', entry.path, err)
    failed.value = '無法讀取這個檔案：ZIP 可能已損壞，或使用了不支援的壓縮方式（例如加密）'
  } finally {
    if (entry === props.entry) loading.value = false
  }
}

watch(() => props.entry, load, { immediate: true })
onBeforeUnmount(revoke)

function save() {
  if (!dirty.value) return
  let out = crlf ? text.value.replace(/\n/g, '\r\n') : text.value
  if (bom) out = `﻿${out}`
  emit('save', new Blob([out], { type: 'text/plain;charset=utf-8' }))
}

function revert() {
  text.value = savedText.value
}

// Only Safari shows HEIC/HEIF. Elsewhere the <img> fails; convert to PNG (heif.js) and show that.
async function onImageError() {
  const entry = props.entry
  if (heifTried || !blob) {
    mediaError.value = true // not HEIF, or even the converted PNG didn't load
    return
  }
  heifTried = true
  convertingHeif.value = true
  try {
    const file = new File([blob], name.value, { type: mimeOf(entry.path) })
    const png = await ensureDecodable(file)
    if (entry !== props.entry) return // switched files meanwhile
    if (png !== file) {
      revoke()
      url.value = URL.createObjectURL(png)
      return
    }
  } catch (err) {
    console.warn('HEIF decode failed', entry.path, err)
  } finally {
    if (entry === props.entry) convertingHeif.value = false
  }
  if (entry === props.entry) mediaError.value = true
}

function onImageLoad(e: Event) {
  const img = e.target as HTMLImageElement
  dims.value = `${img.naturalWidth}×${img.naturalHeight}`
}

const lines = computed(() => (textMode.value ? text.value.split('\n').length : 0))
</script>

<template>
  <section class="pane panel" :aria-label="`預覽 ${name}`">
    <header>
      <div class="title">
        <strong :title="entry.path">{{ name }}</strong>
        <span class="meta">
          {{ fmtBytes(entry.size) }}<template v-if="dims"> · {{ dims }}</template>
          · {{ fmtDate(entry.date) }}<template v-if="dirty"> · <em>未儲存</em></template>
        </span>
      </div>
      <button type="button" class="ib" title="關閉預覽" @click="emit('close')"><Icon name="x" /></button>
    </header>

    <div class="tools">
      <template v-if="textMode">
        <button type="button" class="btn primary" :disabled="!dirty" @click="save">儲存 <kbd>⌘S</kbd></button>
        <button type="button" class="btn" :disabled="!dirty" @click="revert">還原</button>
      </template>
      <template v-if="canSend && !textMode">
        <button v-for="t in sendTargets" :key="t" type="button" class="btn" :title="`傳到${TOOLS[t].label}：${TOOLS[t].hint}`"
                @click="emit('send', t)">
          <Icon name="send" />{{ TOOLS[t].label }}
        </button>
      </template>
      <span class="grow"></span>
      <button type="button" class="ib" title="下載這個檔案" @click="emit('download')"><Icon name="download" /></button>
      <button type="button" class="ib" title="重新命名" @click="emit('rename')"><Icon name="pencil" /></button>
      <button type="button" class="ib danger" title="刪除" @click="emit('remove')"><Icon name="trash" /></button>
    </div>

    <div class="body" :class="{ checker: kind === 'image' && !textMode }">
      <p v-if="loading" class="note">讀取中…</p>
      <p v-else-if="failed" class="note warn">{{ failed }}</p>

      <template v-else-if="textMode">
        <p v-if="notUtf8" class="note warn small">這個檔案不是 UTF-8 文字，顯示可能是亂碼；儲存後會變成 UTF-8。</p>
        <textarea v-model="text" spellcheck="false" autocapitalize="off" autocomplete="off"
                  @keydown.meta.s.prevent="save" @keydown.ctrl.s.prevent="save"></textarea>
        <div class="status">{{ lines.toLocaleString() }} 行 · {{ text.length.toLocaleString() }} 字<template v-if="crlf"> · CRLF</template></div>
      </template>

      <div v-else-if="tooBig" class="note">
        <p>檔案超過 5 MB，以文字開啟可能會很慢。</p>
        <button type="button" class="btn" @click="openAsText(true)">仍要以文字開啟</button>
      </div>

      <template v-else-if="kind === 'image'">
        <p v-if="convertingHeif" class="note">正在解碼 HEIF…</p>
        <img v-else-if="!mediaError" :src="url" :alt="name" @load="onImageLoad" @error="onImageError" />
        <div v-else class="note">
          <p>這個瀏覽器無法預覽這張圖片。</p>
          <p v-if="canSend" class="small">可以傳到 Paste → JPG 轉成 JPG／WebP（支援 HEIC）。</p>
        </div>
      </template>
      <video v-else-if="kind === 'video'" :src="url" controls playsinline></video>
      <audio v-else-if="kind === 'audio'" :src="url" controls></audio>
      <iframe v-else-if="kind === 'pdf'" :src="url" :title="name"></iframe>

      <div v-else class="note">
        <p>這個格式無法預覽。</p>
        <button type="button" class="btn" @click="openAsText()">以文字開啟</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pane { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
header { display: flex; align-items: flex-start; gap: 8px; padding: 12px 10px 8px 14px; }
.title { flex: 1; min-width: 0; }
.title strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.meta em { color: var(--warn); font-style: normal; font-weight: 600; }
.tools { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 10px 10px 14px; border-bottom: 1px solid var(--line); }
.tools .btn { min-height: 32px; padding: 4px 10px; font-size: 13px; }
.tools kbd { padding: 0 4px; border-radius: 4px; background: rgb(255 255 255 / .2); font: inherit; font-size: 11px; opacity: .8; }
.grow { flex: 1; }
.ib {
  display: grid; place-items: center; width: 32px; height: 32px; padding: 0; flex: none;
  border: 0; border-radius: 8px; background: none; color: var(--muted); cursor: pointer;
}
.ib:hover { background: var(--hover); color: var(--text); }
.ib.danger:hover { color: var(--danger); }
.ib .icon { width: 18px; height: 18px; }

.body { position: relative; display: flex; flex: 1; flex-direction: column; min-height: 0; }
.body.checker {
  align-items: center; justify-content: center; padding: 12px;
  background: repeating-conic-gradient(var(--chk) 0 25%, transparent 0 50%) 50% / 20px 20px;
}
.body img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
.body video { width: 100%; max-height: 100%; background: #000; }
.body audio { width: calc(100% - 28px); margin: 24px 14px; }
.body iframe { flex: 1; width: 100%; border: 0; background: #fff; }
textarea {
  flex: 1; width: 100%; min-height: 0; margin: 0; padding: 12px 14px; resize: none;
  border: 0; outline: none; background: var(--panel); color: var(--text);
  font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono CJK TC", monospace;
  tab-size: 4; white-space: pre; overflow: auto;
}
.status { padding: 4px 14px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.note { margin: auto; padding: 24px 16px; color: var(--muted); text-align: center; }
.note p { margin: 0 0 12px; }
.note.small, .small { font-size: 13px; }
.note.warn { color: var(--warn); }
p.note.small { margin: 0; padding: 8px 14px; text-align: left; border-bottom: 1px solid var(--line); }
</style>
