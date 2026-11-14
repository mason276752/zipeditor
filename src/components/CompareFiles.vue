<script setup lang="ts">
// A modified file next to how it was at the baseline: a line diff for text, side by side for
// images, two players for audio and video, two viewers for PDFs, sizes for anything else.
import { onBeforeUnmount, ref, watch } from 'vue'
import { baseName, readEntry, type FileEntry } from '../archive'
import { diffLines, hunks, type DiffGap, type DiffLine } from '../diff'
import { kindOf, looksLikeText, mimeOf, type Kind } from '../kinds'
import { fmtBytes } from '../util'

const props = defineProps<{ base: FileEntry; current: FileEntry }>()

const DIFF_LIMIT = 2 * 1024 * 1024

type View =
  | { type: 'loading' }
  | { type: 'failed' }
  | { type: 'text'; lines: (DiffLine | DiffGap)[]; same: boolean; eol: string }
  | { type: 'tooBig' }
  | { type: 'media'; kind: Kind; before: string; after: string }
  | { type: 'other' }
const view = ref<View>({ type: 'loading' })
const dims = ref<[string, string]>(['', ''])
let urls: string[] = []

function revoke() {
  for (const u of urls) URL.revokeObjectURL(u)
  urls = []
}

async function kindFor(e: FileEntry, blob: Blob): Promise<Kind> {
  const k = kindOf(e.path)
  return k === 'other' && (await looksLikeText(blob)) ? 'text' : k
}

async function load() {
  const { base, current } = props
  revoke()
  view.value = { type: 'loading' }
  dims.value = ['', '']
  try {
    const [a, b] = await Promise.all([readEntry(base), readEntry(current)])
    if (base !== props.base || current !== props.current) return
    const [ka, kb] = await Promise.all([kindFor(base, a), kindFor(current, b)])
    if (ka === 'text' && kb === 'text') {
      if (a.size + b.size > DIFF_LIMIT) {
        view.value = { type: 'tooBig' }
        return
      }
      const [ta, tb] = await Promise.all([a.text(), b.text()])
      const crlf = (t: string) => t.includes('\r\n')
      const eol = crlf(ta) === crlf(tb) ? '' : crlf(tb) ? '換行從 LF 改成 CRLF' : '換行從 CRLF 改成 LF'
      const split = (t: string) => t.replace(/\r\n/g, '\n').split('\n')
      const diff = diffLines(split(ta), split(tb))
      view.value = { type: 'text', lines: hunks(diff), same: diff.every((l) => l.op === ' '), eol }
    } else if (ka === kb && ['image', 'audio', 'video', 'pdf'].includes(ka)) {
      urls = [
        URL.createObjectURL(new Blob([a], { type: mimeOf(base.path) })),
        URL.createObjectURL(new Blob([b], { type: mimeOf(current.path) })),
      ]
      view.value = { type: 'media', kind: ka, before: urls[0], after: urls[1] }
    } else {
      view.value = { type: 'other' }
    }
  } catch (err) {
    console.warn('compare failed', err)
    view.value = { type: 'failed' }
  }
}

function onImage(i: 0 | 1, e: Event) {
  const img = e.target as HTMLImageElement
  dims.value[i] = ` · ${img.naturalWidth}×${img.naturalHeight}`
}

watch(() => [props.base, props.current], load, { immediate: true })
onBeforeUnmount(revoke)

const renamed = () => baseName(props.base.path) !== baseName(props.current.path)
</script>

<template>
  <div class="compare">
    <p v-if="renamed()" class="renamed">原本是「{{ base.path }}」</p>

    <p v-if="view.type === 'loading'" class="note">讀取中…</p>
    <p v-else-if="view.type === 'failed'" class="note warn">無法讀取原檔或目前的檔案。</p>

    <template v-else-if="view.type === 'text'">
      <p v-if="view.eol" class="renamed">{{ view.eol }}</p>
      <p v-if="view.same" class="note">內容沒有改變{{ renamed() ? '，只改了檔名' : '' }}。</p>
      <div v-else class="diff" role="table" aria-label="和原檔的差異">
        <template v-for="(l, i) in view.lines" :key="i">
          <div v-if="'skip' in l" class="gap">⋯ {{ l.skip }} 行沒變</div>
          <div v-else class="line" :class="{ del: l.op === '-', add: l.op === '+' }">
            <span class="no">{{ l.a ?? '' }}</span>
            <span class="no">{{ l.b ?? '' }}</span>
            <span class="op">{{ l.op }}</span>
            <span class="txt">{{ l.text }}</span>
          </div>
        </template>
      </div>
    </template>

    <p v-else-if="view.type === 'tooBig'" class="note">
      檔案太大，不顯示差異（原檔 {{ fmtBytes(base.size) }}，目前 {{ fmtBytes(current.size) }}）。
    </p>

    <div v-else-if="view.type === 'media'" class="pair" :class="view.kind">
      <figure v-for="(side, i) in [{ label: '原檔', e: base, url: view.before }, { label: '目前', e: current, url: view.after }]"
              :key="side.label">
        <figcaption><b>{{ side.label }}</b> {{ baseName(side.e.path) }} · {{ fmtBytes(side.e.size) }}{{ dims[i] }}</figcaption>
        <div class="media">
          <img v-if="view.kind === 'image'" :src="side.url" :alt="side.label" @load="onImage(i as 0 | 1, $event)" />
          <video v-else-if="view.kind === 'video'" :src="side.url" controls playsinline></video>
          <audio v-else-if="view.kind === 'audio'" :src="side.url" controls></audio>
          <iframe v-else :src="side.url" :title="side.label"></iframe>
        </div>
      </figure>
    </div>

    <p v-else class="note">
      這種檔案無法比較內容。原檔 {{ fmtBytes(base.size) }}，目前 {{ fmtBytes(current.size) }}。
    </p>
  </div>
</template>

<style scoped>
.compare { display: flex; flex: 1; flex-direction: column; min-height: 0; }
.renamed { margin: 0; padding: 8px 14px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 13px; }
.note { margin: auto; padding: 24px 16px; color: var(--muted); text-align: center; }
.note.warn { color: var(--warn); }

.diff {
  flex: 1; min-height: 0; overflow: auto;
  font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono CJK TC", monospace;
}
.line { display: grid; grid-template-columns: 3.5em 3.5em 1.5em max-content; min-width: max-content; }
.no { padding-right: 8px; color: var(--muted); text-align: right; user-select: none; }
.op { color: var(--muted); text-align: center; user-select: none; }
.txt { padding-right: 14px; white-space: pre; tab-size: 4; }
.line.del { background: color-mix(in srgb, var(--danger) 14%, transparent); }
.line.add { background: color-mix(in srgb, var(--accent) 16%, transparent); }
.line.del .op { color: var(--danger); }
.line.add .op { color: var(--accent); }
.gap {
  padding: 2px 14px; border-block: 1px solid var(--line); background: var(--hover);
  color: var(--muted); font-size: 12px;
}

.pair { display: grid; flex: 1; grid-template-columns: 1fr 1fr; gap: 1px; min-height: 0; background: var(--line); }
.pair.pdf, .pair.video { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; }
figure { display: flex; flex-direction: column; min-width: 0; min-height: 0; margin: 0; background: var(--panel); }
figcaption { padding: 6px 10px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
figcaption b { color: var(--text); }
.media { display: flex; flex: 1; align-items: center; justify-content: center; min-height: 0; padding: 8px; }
.image .media { background: repeating-conic-gradient(var(--chk) 0 25%, transparent 0 50%) 50% / 20px 20px; }
.media img, .media video { max-width: 100%; max-height: 100%; object-fit: contain; }
.media audio { width: 100%; }
.media iframe { flex: 1; align-self: stretch; border: 0; background: #fff; }
.pdf .media { padding: 0; }
</style>
