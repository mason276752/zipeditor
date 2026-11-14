<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  baseName, joinPath, normalizePath, parentOf, readEntry, useArchive,
  type ArchiveState, type Crumb, type FileEntry, type NameEncoding, type Row,
} from './archive'
import {
  bridgeSupported, FILE_TOOLS, listen, newId, replyAddress, send, toolLabel, TOOLS,
  type FileKind, type ResultUpdate, type SendResult, type Tool, type ZipDelivery,
} from './bridge'
import { kindOf, mimeOf } from './kinds'
import { droppedFiles, fmtBytes, pickedFiles, saveBlob, timeStamp, type Picked } from './util'
import FileList from './components/FileList.vue'
import PreviewPane from './components/PreviewPane.vue'
import Icon from './components/Icon.vue'

const archive = useArchive()
const { isOpen, name, files, allDirs, totalSize, dirty, changeCount, legacyNames, encoding, canUndo, canRedo } = archive

const cwd = ref('')
const selected = ref(new Set<string>())
const activePath = ref<string | null>(null)
const renaming = ref<string | null>(null)
const editorDirty = ref(false)
const inbox = ref<ZipDelivery[]>([])
const pendingConvert = ref<string | null>(null)
const level = ref(6)
const busy = ref('')
const dragging = ref(false)

const zipInput = ref<HTMLInputElement>()
const filesInput = ref<HTMLInputElement>()
const dirInput = ref<HTMLInputElement>()

const rows = computed(() => archive.children(cwd.value))
const activeEntry = computed(() => (activePath.value && files.value.get(activePath.value)) || null)
const selectedRows = computed(() => rows.value.filter((r) => selected.value.has(r.path)))
const selectedOfKind = (k: FileKind) => selectedRows.value.filter((r) => !r.dir && kindOf(r.name) === k)
const selectedByKind = computed(() =>
  (Object.keys(FILE_TOOLS) as FileKind[]).map((k) => ({ kind: k, rows: selectedOfKind(k) })).filter((g) => g.rows.length),
)
const KIND_UNIT: Record<FileKind, string> = { image: '張圖片', audio: '個音檔', pdf: '個 PDF ' }
const cwdName = computed(() => (cwd.value ? baseName(cwd.value) : name.value))
const entryRow = (e: FileEntry): Row => ({
  path: e.path, name: baseName(e.path), dir: false, size: e.size, date: e.date, count: 0, entry: e,
})
const zipFileName = computed(() => {
  const n = name.value.trim() || 'archive'
  return /\.zip$/i.test(n) ? n : `${n}.zip`
})

// ---------- toast ----------
const toastMsg = ref('')
const toastAction = ref<{ label: string; run: () => void } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | undefined
function toast(msg: string, action: { label: string; run: () => void } | null = null) {
  toastMsg.value = msg
  toastAction.value = action
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastMsg.value = '' }, action ? 6000 : 3200)
}
const undoAction = { label: '復原', run: () => undo() }

// ---------- keep view state valid as the archive changes ----------
watch(allDirs, (dirs) => {
  let p = cwd.value
  while (p && !dirs.has(p)) p = parentOf(p)
  cwd.value = p
})
watch(files, (f) => {
  if (activePath.value && !f.has(activePath.value)) activePath.value = null
  for (const p of [...selected.value]) if (!f.has(p) && !allDirs.value.has(p)) selected.value.delete(p)
})
watch(cwd, () => {
  selected.value.clear()
  renaming.value = null
})

function confirmDiscardEdits() {
  return !editorDirty.value || confirm('文字檔還沒儲存，要放棄這些修改嗎？')
}
// Anything not downloaded yet, in the open zip or in a zip it sits inside.
const unsavedAnywhere = () =>
  dirty.value || editorDirty.value || unsavedInParent.value || levels.value.some((l) => l.outer.dirty)
function confirmDiscardArchive() {
  return !unsavedAnywhere() || confirm('目前的 ZIP 有尚未下載的修改，要放棄嗎？')
}

function resetView() {
  cwd.value = ''
  activePath.value = null
  selected.value.clear()
  renaming.value = null
  editorDirty.value = false
}

// ---------- open / create ----------
// `nested`: a zip inside the open one (see enterZip); anything else replaces all levels.
async function openZip(file: Blob, fileName: string, nested = false) {
  try {
    await archive.open(file, fileName)
  } catch (err) {
    console.warn('open failed', err)
    toast(`無法開啟「${fileName}」：不是有效的 ZIP 檔`)
    return false
  }
  if (!nested) levels.value = []
  resetView()
  return true
}

function onPickZip() {
  const file = zipInput.value?.files?.[0]
  if (zipInput.value) zipInput.value.value = ''
  if (file && confirmDiscardArchive()) openZip(file, file.name)
}

function newArchive() {
  if (!confirmDiscardArchive()) return
  archive.create(`archive-${timeStamp()}.zip`)
  resetView()
}

function closeArchive() {
  if (!confirmDiscardArchive()) return
  archive.close()
  levels.value = []
  resetView()
}

// ---------- zips inside the zip ----------
// Opening a .zip inside the zip sets the outer one aside (undo history and changes included) and
// edits the inner one in its place. 「存回」 packs it and writes it over its file in the outer zip;
// leaving does the same first if anything changed. Each level keeps the outer zip, where the inner
// one sits in it, and the folder you were in.
interface Level {
  outer: ArchiveState
  path: string
  cwd: string
  saved: { files: Map<string, FileEntry>; dirs: Set<string> } // the inner zip as last written back
}
const levels = shallowRef<Level[]>([])
const parentName = computed(() => levels.value.at(-1)?.outer.name ?? '')
const isZipRow = (row: Row) => !row.dir && !row.gone && /\.zip$/i.test(row.name)
const savedState = () => ({ files: files.value, dirs: archive.dirs.value })
// Every change makes new maps, so undoing back to how the zip was opened counts as nothing to save.
const unsavedInParent = computed(() => {
  const l = levels.value.at(-1)
  return !!l && (l.saved.files !== files.value || l.saved.dirs !== archive.dirs.value)
})
const patchLevel = (i: number, patch: Partial<Level>) => {
  levels.value = levels.value.map((l, j) => (j === i ? { ...l, ...patch } : l))
}

async function enterZip(row: Row) {
  if (!confirmDiscardEdits()) return
  let blob: Blob
  try {
    blob = await readEntry(row.entry!)
  } catch {
    toast('無法讀取這個檔案')
    return
  }
  const outer = archive.suspend()
  const at = cwd.value
  if (!(await openZip(blob, row.name, true))) {
    archive.resume(outer)
    return
  }
  levels.value = [...levels.value, { outer, path: row.path, cwd: at, saved: savedState() }]
}

// Text not yet saved in the preview isn't included.
async function saveToParent(): Promise<boolean> {
  const i = levels.value.length - 1
  const l = levels.value[i]
  if (!l || busy.value) return false
  busy.value = '存回中…'
  try {
    const blob = await archive.generate(level.value, (p) => { busy.value = `存回中 ${Math.floor(p)}%` })
    const inner = archive.suspend()
    archive.resume(l.outer)
    archive.writeFile(l.path, blob, `存回「${baseName(l.path)}」`)
    const outer = archive.suspend()
    archive.resume(inner)
    archive.markSaved()
    patchLevel(i, { outer, saved: savedState() })
    return true
  } catch (err) {
    console.warn('generate failed', err)
    toast('打包失敗：有檔案無法讀取')
    return false
  } finally {
    busy.value = ''
  }
}

async function saveClicked() {
  if (editorDirty.value) {
    toast('文字檔還沒儲存，請先按「儲存」')
    return
  }
  if (await saveToParent()) toast(`已存回「${parentName.value}」`)
}

async function leaveZip() {
  if (!levels.value.length || !confirmDiscardEdits()) return false
  const changed = unsavedInParent.value
  if (changed && !(await saveToParent())) return false
  const l = levels.value.at(-1)!
  archive.resume(l.outer)
  levels.value = levels.value.slice(0, -1)
  resetView()
  cwd.value = l.cwd
  if (changed) toast(`已把「${baseName(l.path)}」的修改存回來`, undoAction)
  return true
}

async function leaveTo(depth: number, path: string) {
  while (levels.value.length > depth) if (!(await leaveZip())) return
  cwd.value = path
}

function onCrumb(c: Crumb) {
  if (c.depth === levels.value.length) navigate(c.path)
  else leaveTo(c.depth, c.path)
}

// The outer zips and the folders down to each inner one, then the open zip and its folder.
const crumbs = computed(() => {
  const out: Crumb[] = []
  const depth = levels.value.length
  const add = (zipName: string, d: number, dir: string) => {
    out.push({ name: zipName, depth: d, path: '', zip: true, here: d === depth && !cwd.value })
    let acc = ''
    for (const part of dir ? dir.split('/') : []) {
      acc = acc ? `${acc}/${part}` : part
      out.push({ name: part, depth: d, path: acc, zip: false, here: d === depth && acc === cwd.value })
    }
  }
  levels.value.forEach((l, d) => add(l.outer.name, d, parentOf(l.path)))
  add(zipFileName.value, depth, cwd.value)
  return out
})

async function changeEncoding(e: Event) {
  const enc = (e.target as HTMLSelectElement).value as NameEncoding
  if (dirty.value && !confirm('換編碼會重新讀取 ZIP，目前的修改會消失，要繼續嗎？')) {
    (e.target as HTMLSelectElement).value = encoding.value
    return
  }
  await archive.reopenWithEncoding(enc)
  resetView()
}

// ---------- adding ----------
function addPicked(picked: Picked) {
  if (!picked.files.length && !picked.dirs.length) return
  if (!isOpen.value) archive.create(`archive-${timeStamp()}.zip`)
  const list = picked.files.map(({ path, file }) => ({
    path: joinPath(cwd.value, path), blob: file as Blob, date: new Date(file.lastModified || Date.now()),
  }))
  const replaced = list.filter((f) => files.value.has(normalizePath(f.path))).length
  archive.addFiles(list, picked.dirs.map((d) => joinPath(cwd.value, d)))
  toast(`已新增 ${list.length} 個檔案${replaced ? `（取代 ${replaced} 個同名檔案）` : ''}`, undoAction)
}

function onPickFiles(input: HTMLInputElement | undefined) {
  if (!input?.files) return
  addPicked(pickedFiles(input.files))
  input.value = ''
}

function uniquePath(dir: string, stem: string, ext = '', taken: (p: string) => boolean = archive.exists) {
  let p = joinPath(dir, stem + ext)
  for (let n = 2; taken(p); n++) p = joinPath(dir, `${stem} ${n}${ext}`)
  return p
}

function newTextFile() {
  if (!confirmDiscardEdits()) return
  const path = uniquePath(cwd.value, '新文字檔', '.txt')
  archive.addFiles([{ path, blob: new Blob([], { type: 'text/plain' }) }], [], '新增文字檔')
  activePath.value = path
  renaming.value = path
}

function newFolder() {
  const path = uniquePath(cwd.value, '新資料夾')
  archive.mkdir(path)
  renaming.value = path
}

// ---------- editing ----------
function openRow(row: Row) {
  if (isZipRow(row)) {
    enterZip(row)
    return
  }
  if (row.path === activePath.value || !confirmDiscardEdits()) return
  activePath.value = row.path
}

function closePreview() {
  if (confirmDiscardEdits()) activePath.value = null
}

function navigate(path: string) {
  cwd.value = path
}

// A name with "/" moves the item: relative to its folder, or from the root when it starts with "/".
function rename(row: Row, input: string) {
  renaming.value = null
  const value = input.trim()
  if (!value || value === row.name) return
  const to = value.startsWith('/') ? normalizePath(value) : joinPath(parentOf(row.path), value)
  if (!to || to === row.path) return
  if (to.split('/').includes('..')) { toast('名稱不能包含「..」'); return }
  if (row.dir && to.startsWith(`${row.path}/`)) { toast('不能把資料夾移到它自己裡面'); return }
  if (archive.exists(to) && !confirm(`「${to}」已經存在，要覆蓋嗎？`)) return
  archive.rename(row, to)
  const a = activePath.value
  if (a === row.path) activePath.value = to
  else if (row.dir && a?.startsWith(`${row.path}/`)) activePath.value = to + a.slice(row.path.length)
}

function remove(list: Row[]) {
  if (!list.length) return
  if (activePath.value && list.some((r) => r.path === activePath.value || activePath.value!.startsWith(`${r.path}/`))) {
    editorDirty.value = false
  }
  archive.remove(list)
  selected.value.clear()
  toast(list.length === 1 ? `已刪除「${list[0].name}」` : `已刪除 ${list.length} 個項目`, undoAction)
}

function removeActive() {
  if (activeEntry.value) remove([entryRow(activeEntry.value)])
}

function saveText(blob: Blob) {
  if (!activePath.value) return
  archive.writeFile(activePath.value, blob)
  toast('已儲存')
}

function toggle(path: string) {
  if (!selected.value.delete(path)) selected.value.add(path)
}
function toggleAll(on: boolean) {
  selected.value.clear()
  if (on) for (const r of rows.value) if (!r.gone) selected.value.add(r.path)
}

function undo() {
  const label = archive.undo()
  if (label) toast(`已復原：${label}`)
}
function redo() {
  const label = archive.redo()
  if (label) toast(`已重做：${label}`)
}

// ---------- downloading ----------
async function downloadRow(row: Row) {
  if (!row.entry) return
  try {
    saveBlob(await readEntry(row.entry), row.name)
  } catch {
    toast('無法讀取這個檔案')
  }
}

async function downloadZip() {
  if (busy.value) return
  busy.value = '壓縮中…'
  try {
    const blob = await archive.generate(level.value, (p) => { busy.value = `壓縮中 ${Math.floor(p)}%` })
    saveBlob(blob, zipFileName.value)
    archive.markSaved()
    toast(`已下載 ${zipFileName.value}（${fmtBytes(blob.size)}）`)
  } catch (err) {
    console.warn('generate failed', err)
    toast('打包失敗：有檔案無法讀取')
  } finally {
    busy.value = ''
  }
}

// ---------- other tools ----------
function reportFailure(result: SendResult, target: Tool) {
  const label = TOOLS[target].label
  if (result === 'blocked') toast(`瀏覽器擋下了新分頁，請先開啟${label}再試一次`)
  else toast(`${label}沒有回應，請再試一次`)
}

let convertDoc = 0 // the zip being converted: the result is dropped if another one is open by then

async function convert() {
  if (pendingConvert.value || !files.value.size) return
  convertDoc = archive.docId()
  // Set before sending: the converted zip can come back right after the ack.
  const id = (pendingConvert.value = newId())
  const result = await send('ziptotaiwanzip', async () => ({
    type: 'zip',
    id,
    // No point deflating for a hop to another tab; it repacks the zip anyway.
    file: new File([await archive.generate(0)], zipFileName.value, { type: 'application/zip' }),
    replyTo: replyAddress,
  }))
  if (result !== 'sent' && pendingConvert.value === id) {
    pendingConvert.value = null
    reportFailure(result, 'ziptotaiwanzip')
  }
}

// Images go to paste2jpg / upscale / removebg, audio to audiospeed, PDFs to pdfcompress. Each file
// carries its origin, so the tool sends every result (and every later change to it) straight back:
// see onUpdate.
async function sendFiles(target: Tool, list: Row[], kind: FileKind) {
  if (!list.length) return
  const doc = archive.docId()
  const result = await send(target, async () => ({
    type: 'files',
    id: newId(),
    files: await Promise.all(
      list.map(async (r) => new File([await readEntry(r.entry!)], r.name, { type: mimeOf(r.name) })),
    ),
    origins: list.map((r) => ({ ...replyAddress, key: `${doc}\n${r.path}` })),
  }))
  const label = TOOLS[target].label
  if (result === 'sent') toast(`已傳送 ${list.length} ${KIND_UNIT[kind]}到${label}，處理好會自動放回原檔旁邊`)
  else reportFailure(result, target)
}

// Where each tool result went, by `${doc}\n${from}\n${output}`, so a newer version of a result
// replaces the older one even after its name changed (e.g. PNG → WebP).
const resultPaths = new Map<string, string>()

function onUpdate(u: ResultUpdate) {
  const cut = u.key.indexOf('\n')
  const doc = Number(u.key.slice(0, cut))
  const source = u.key.slice(cut + 1)
  const label = toolLabel(u.from)
  // Sent from a zip that is now set aside while a zip inside it is open: write it there.
  const outerIndex = levels.value.findIndex((l) => l.outer.doc === doc)
  if (!isOpen.value || (doc !== archive.docId() && outerIndex < 0)) {
    toast(`「${label}」傳回的 ${u.file.name} 沒有放進來：原本的 ZIP 已經關掉或換掉了`)
    return
  }
  const name = u.file.name.replace(/[\\/]/g, '_') || 'result'
  const id = `${doc}\n${u.from}\n${u.output}`
  const prev = resultPaths.get(id)
  let path = prev && baseName(prev) === name ? prev : ''
  if (!path) {
    // Next to the original, numbered if another result already took that name.
    const taken = new Set([...resultPaths].filter(([k]) => k !== id && k.startsWith(`${doc}\n`)).map(([, p]) => p))
    const dot = name.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
    path = uniquePath(parentOf(source), stem, ext, (p) => taken.has(p))
  }
  if (outerIndex >= 0) {
    const inner = archive.suspend()
    archive.resume(levels.value[outerIndex].outer)
    archive.putResult(path, u.file, prev, `「${label}」傳回的結果`, `result:${u.from}`)
    const outer = archive.suspend()
    archive.resume(inner)
    patchLevel(outerIndex, { outer })
    resultPaths.set(id, path)
    toast(`已${prev ? '更新' : '放入'}「${levels.value[outerIndex].outer.name}」裡的「${path}」（${label}）`)
    return
  }
  archive.putResult(path, u.file, prev, `「${label}」傳回的結果`, `result:${u.from}`)
  resultPaths.set(id, path)
  toast(`已${prev ? '更新' : '放入'}「${path}」（${label}）`, undoAction)
}

function sendActive(target: Tool) {
  const e = activeEntry.value
  const kind = e && kindOf(baseName(e.path))
  if (e && kind && kind in FILE_TOOLS) sendFiles(target, [entryRow(e)], kind as FileKind)
}

async function onZip(d: ZipDelivery) {
  if (d.inReplyTo && d.inReplyTo === pendingConvert.value) {
    pendingConvert.value = null
    if (convertDoc !== archive.docId()) {
      toast('簡繁轉換的結果沒有套用：已經換到別的 ZIP 了')
      return
    }
    try {
      await archive.replaceWith(d.file, '簡繁轉換')
      activePath.value = null
      editorDirty.value = false
      toast('已套用簡繁轉換', undoAction)
    } catch {
      toast('轉換結果無法讀取')
    }
    return
  }
  if (!isOpen.value || (!dirty.value && !files.value.size && !levels.value.length)) {
    if (await openZip(d.file, d.file.name)) toast(`已開啟「${toolLabel(d.from)}」傳來的 ${d.file.name}`)
    return
  }
  inbox.value.push(d)
}

function dismiss(d: ZipDelivery) {
  inbox.value = inbox.value.filter((x) => x !== d)
}

async function openDelivery(d: ZipDelivery) {
  if (!confirmDiscardArchive()) return
  dismiss(d)
  await openZip(d.file, d.file.name)
}

async function mergeDelivery(d: ZipDelivery) {
  dismiss(d)
  try {
    await archive.mergeFrom(d.file, cwd.value, `合併 ${d.file.name}`)
    toast(`已把 ${d.file.name} 合併到「${cwdName.value}」`, undoAction)
  } catch {
    toast(`無法讀取 ${d.file.name}`)
  }
}

// ---------- page-level input ----------
const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))

function onKeydown(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey
  if (!isOpen.value || isTyping(e.target)) return
  const key = e.key.toLowerCase()
  if (mod && key === 'z') {
    e.preventDefault()
    if (e.shiftKey) redo()
    else undo()
  } else if (mod && key === 'y') {
    e.preventDefault()
    redo()
  } else if (key === 'escape' && activePath.value) {
    closePreview()
  }
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (isOpen.value && unsavedAnywhere()) {
    e.preventDefault()
    e.returnValue = ''
  }
}

let dragDepth = 0
const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
function onDragEnter(e: DragEvent) {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth++
  dragging.value = true
}
function onDragOver(e: DragEvent) {
  if (!hasFiles(e)) return
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'copy'
}
function onDragLeave(e: DragEvent) {
  if (hasFiles(e) && --dragDepth <= 0) {
    dragDepth = 0
    dragging.value = false
  }
}
async function onDrop(e: DragEvent) {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth = 0
  dragging.value = false
  const dt = e.dataTransfer!
  const only = dt.files.length === 1 ? dt.files[0] : null
  if (!isOpen.value && only && /\.zip$/i.test(only.name)) {
    openZip(only, only.name)
    return
  }
  try {
    addPicked(await droppedFiles(dt))
  } catch (err) {
    console.warn('drop failed', err)
    toast('無法讀取拖進來的檔案')
  }
}

let stopListening = () => {}
onMounted(() => {
  if (dirInput.value) dirInput.value.webkitdirectory = true
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('beforeunload', onBeforeUnload)
  window.addEventListener('dragenter', onDragEnter)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
  stopListening = listen(onZip, onUpdate)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('dragenter', onDragEnter)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
  stopListening()
})
</script>

<template>
  <div class="app" :class="{ dragging }" :data-drop-label="isOpen ? `放開以加入到「${cwdName}」` : '放開以開啟或打包'">
    <header class="top">
      <div class="brand">
        <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#0f8a6c"/><path d="M9 7h9l5 5v13H9z" fill="#fff"/><path d="M18 7v5h5" fill="#bfe8dc"/><path d="M14 9h2v2h-2zm0 3h2v2h-2zm0 3h2v2h-2zm-.5 3h3v4h-3z" fill="#0f8a6c"/></svg>
        <div>
          <h1>ZIP 編輯器</h1>
          <p v-if="!isOpen">在瀏覽器裡開啟、預覽、編輯 ZIP，檔案不會離開你的裝置。</p>
        </div>
      </div>
      <div v-if="isOpen" class="archive">
        <input v-model="name" class="zipname" aria-label="ZIP 檔名" spellcheck="false" />
        <span class="stats">
          {{ files.size.toLocaleString() }} 個檔案 · {{ fmtBytes(totalSize) }}
          <span v-if="dirty && !changeCount.total" class="badge">尚未下載</span>
        </span>
        <span v-if="changeCount.total" class="changes" title="上次下載或按「確定」之後的變更">
          <span v-if="changeCount.U" class="ch-U">新增 {{ changeCount.U }}</span>
          <span v-if="changeCount.M" class="ch-M">修改 {{ changeCount.M }}</span>
          <span v-if="changeCount.D" class="ch-D">刪除 {{ changeCount.D }}</span>
          <button type="button" class="btn small" title="把目前的狀態當成基準，標記變回一般顏色（不會下載）"
                  @click="archive.acceptChanges()">確定</button>
        </span>
      </div>
    </header>

    <template v-if="!isOpen">
      <section class="start panel">
        <Icon name="zip" class="hero" />
        <strong>把 ZIP 拖進來開啟</strong>
        <span>也可以拖入一般檔案或整個資料夾，直接打包成新的 ZIP</span>
        <div class="start-btns">
          <button type="button" class="btn primary" @click="zipInput?.click()"><Icon name="upload" />開啟 ZIP</button>
          <button type="button" class="btn" @click="newArchive"><Icon name="filePlus" />建立新的 ZIP</button>
        </div>
      </section>

      <section class="about panel">
        <h2>可以做什麼</h2>
        <ul>
          <li><strong>預覽</strong>：圖片、影片、音樂、PDF 與文字檔直接在頁面上看，不用先解壓縮。</li>
          <li><strong>編輯</strong>：文字檔（程式碼、設定檔、字幕、Markdown…）可以直接修改並儲存回 ZIP。</li>
          <li><strong>整理</strong>：新增、刪除、重新命名檔案與資料夾；名稱裡打「/」可以搬到別的資料夾。所有操作都能復原（⌘Z）。</li>
          <li><strong>重新打包</strong>：選擇壓縮程度後下載；沒動過的檔案會沿用原本壓縮好的資料，大 ZIP 也很快。</li>
          <li><strong>ZIP 裡的 ZIP</strong>：點一下就打開來編輯，改好按「存回」（或直接回到外層）就寫回外面的 ZIP；也可以單獨下載裡面這個 ZIP。</li>
          <li><strong>看得到改了什麼</strong>：新增、修改、刪除的檔案分別標成綠色 U、橘色 M、紅色 D，下載或按「確定」後恢復。</li>
          <li><strong>中文檔名</strong>：Windows 做的 GBK／Big5 編碼 ZIP 也能正確顯示檔名。</li>
          <li><strong>串接其他工具</strong>：可以把 ZIP 傳到<a href="../ziptotaiwanzip/">簡繁轉換工具</a>轉換後自動傳回來；圖片可以傳到 <a href="../paste2jpg/">Paste → JPG</a> 壓縮、<a href="../upscale/">圖片放大</a>、<a href="../removebg/">去背</a>，音檔可以傳到<a href="../audiospeed/">音檔變速</a>，處理好的結果都能直接傳回來。</li>
        </ul>
      </section>
    </template>

    <template v-else>
      <div class="toolbar panel">
        <div class="group">
          <button type="button" class="btn" @click="filesInput?.click()"><Icon name="upload" /><span>加入檔案</span></button>
          <button type="button" class="btn" @click="dirInput?.click()"><Icon name="folderUp" /><span>加入資料夾</span></button>
          <button type="button" class="btn" @click="newTextFile"><Icon name="filePlus" /><span>新文字檔</span></button>
          <button type="button" class="btn" @click="newFolder"><Icon name="folderPlus" /><span>新資料夾</span></button>
        </div>
        <div class="group">
          <button type="button" class="btn icon" :disabled="!canUndo" title="復原（⌘Z）" @click="undo"><Icon name="undo" /></button>
          <button type="button" class="btn icon" :disabled="!canRedo" title="重做（⌘⇧Z）" @click="redo"><Icon name="redo" /></button>
          <button v-if="bridgeSupported" type="button" class="btn" :disabled="!files.size || !!pendingConvert"
                  title="傳到簡繁轉換工具（ziptotaiwanzip）轉換檔名與文字內容，完成後自動傳回" @click="convert">
            <Icon name="swap" /><span>簡繁轉換</span>
          </button>
        </div>
        <div class="group end">
          <select v-model.number="level" aria-label="壓縮程度" title="壓縮程度">
            <option :value="0">不壓縮</option>
            <option :value="6">標準壓縮</option>
            <option :value="9">最大壓縮</option>
          </select>
          <button v-if="levels.length" type="button" class="btn primary" :disabled="!!busy"
                  :title="`用選擇的壓縮程度重新打包，寫回「${parentName}」裡的檔案`" @click="saveClicked">
            <Icon name="saveUp" /><span class="clip">{{ busy || `存回「${parentName}」` }}</span>
          </button>
          <button type="button" class="btn" :class="{ primary: !levels.length }" :disabled="!!busy"
                  :title="levels.length ? `下載「${zipFileName}」這個 ZIP` : undefined" @click="downloadZip">
            <Icon name="download" />{{ !levels.length && busy ? busy : '下載 ZIP' }}
          </button>
          <button v-if="levels.length" type="button" class="btn icon" :title="`回到「${parentName}」（有修改會先存回）`"
                  @click="leaveZip"><Icon name="x" /></button>
          <button v-else type="button" class="btn icon" title="關閉這個 ZIP" @click="closeArchive"><Icon name="x" /></button>
        </div>
      </div>

      <div v-if="legacyNames" class="banner">
        <span>這個 ZIP 的檔名不是 UTF-8 編碼。如果看到亂碼，換一種編碼試試：</span>
        <select :value="encoding" aria-label="檔名編碼" @change="changeEncoding">
          <option value="auto">自動（UTF-8／GBK）</option>
          <option value="gb18030">GBK（簡體中文 Windows）</option>
          <option value="big5">Big5（繁體中文 Windows）</option>
          <option value="shift_jis">Shift_JIS（日文 Windows）</option>
          <option value="utf-8">UTF-8</option>
        </select>
      </div>

      <div v-if="pendingConvert" class="banner">
        <span class="spinner" aria-hidden="true"></span>
        <span class="grow">正在用簡繁轉換工具轉換，完成後會自動套用到這裡…</span>
        <button type="button" class="btn small" @click="pendingConvert = null">取消</button>
      </div>

      <div v-for="d in inbox" :key="d.id" class="banner">
        <Icon name="inbox" />
        <span class="grow">收到「{{ toolLabel(d.from) }}」傳來的 <b>{{ d.file.name }}</b>（{{ fmtBytes(d.file.size) }}）</span>
        <button type="button" class="btn small primary" @click="mergeDelivery(d)">合併到「{{ cwdName }}」</button>
        <button type="button" class="btn small" @click="openDelivery(d)">改開這個 ZIP</button>
        <button type="button" class="btn small" @click="dismiss(d)">忽略</button>
      </div>

      <div v-if="selected.size" class="selbar">
        <span class="grow">已選取 {{ selected.size }} 項</span>
        <template v-if="bridgeSupported">
          <span v-for="g in selectedByKind" :key="g.kind" class="send-group">
            <Icon name="send" />{{ g.rows.length }} {{ KIND_UNIT[g.kind] }}傳到
            <button v-for="t in FILE_TOOLS[g.kind]" :key="t" type="button" class="btn small"
                    :title="`傳到${TOOLS[t].label}：${TOOLS[t].hint}`" @click="sendFiles(t, g.rows, g.kind)">
              {{ TOOLS[t].label }}
            </button>
          </span>
        </template>
        <button type="button" class="btn small danger" @click="remove(selectedRows)"><Icon name="trash" />刪除</button>
        <button type="button" class="btn small" @click="selected.clear()">取消選取</button>
      </div>

      <div class="work" :class="{ previewing: activeEntry }">
        <FileList class="panel" :rows="rows" :crumbs="crumbs" :selected="selected"
                  :active="activePath" :renaming="renaming" @crumb="onCrumb"
                  @navigate="navigate" @open="openRow" @toggle="toggle" @toggle-all="toggleAll"
                  @start-rename="(p) => (renaming = p)" @rename="rename" @cancel-rename="renaming = null"
                  @remove="(r) => remove([r])" @download="downloadRow" />
        <PreviewPane v-if="activeEntry" :entry="activeEntry" :can-send="bridgeSupported"
                     @close="closePreview" @save="saveText" @dirty="(d) => (editorDirty = d)"
                     @download="downloadRow(entryRow(activeEntry))"
                     @rename="renaming = activeEntry.path" @remove="removeActive" @send="sendActive" />
      </div>
    </template>

    <footer>
      ZIP 編輯器 · 所有運算都在瀏覽器內完成 ·
      <a href="../">更多工具</a> ·
      <a href="https://github.com/mason276752/zipeditor">GitHub 原始碼</a>
    </footer>

    <div class="toast" :class="{ show: toastMsg }" role="status" aria-live="polite">
      <span>{{ toastMsg }}</span>
      <button v-if="toastAction" type="button" @click="toastAction.run(); toastMsg = ''">{{ toastAction.label }}</button>
    </div>

    <input ref="zipInput" type="file" accept=".zip,application/zip" hidden @change="onPickZip" />
    <input ref="filesInput" type="file" multiple hidden @change="onPickFiles(filesInput)" />
    <input ref="dirInput" type="file" hidden @change="onPickFiles(dirInput)" />
  </div>
</template>
