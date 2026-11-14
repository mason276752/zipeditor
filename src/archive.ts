import JSZip from 'jszip'
import { computed, ref, shallowRef } from 'vue'

export interface FileEntry {
  path: string
  size: number
  date: Date
  // Untouched entries keep their JSZipObject so the original compressed bytes can be reused.
  source: Blob | JSZip.JSZipObject
}

export interface Row {
  path: string
  name: string
  dir: boolean
  size: number
  date: Date | null
  count: number // files inside, for folders
  entry?: FileEntry
}

export type NameEncoding = 'auto' | 'utf-8' | 'gb18030' | 'big5' | 'shift_jis'

interface Snapshot {
  files: Map<string, FileEntry>
  dirs: Set<string>
  label: string
}

const HISTORY_LIMIT = 100
// Root collation: digits and Latin before CJK, like most file managers; "2" before "10".
const collator = new Intl.Collator('en', { numeric: true })

// ---------- paths ----------
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.').join('/')
}
export const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
export const parentOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')))
export const joinPath = (dir: string, name: string) => normalizePath(dir ? `${dir}/${name}` : name)

// Folders that `path` lives in, nearest first (the root '' is left out).
function ancestors(path: string): string[] {
  const out: string[] = []
  for (let p = parentOf(path); p; p = parentOf(p)) out.push(p)
  return out
}

// Zip timestamps are wall-clock time with no zone, but JSZip reads and writes them as UTC.
// Convert at the boundary so the list shows, and new entries store, local time.
const fromZipDate = (d: Date) =>
  new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds())
const toZipDate = (d: Date) =>
  new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()))

// ---------- reading zips ----------
function decodeName(bytes: Uint8Array, encoding: NameEncoding): string {
  if (encoding !== 'auto') return new TextDecoder(encoding).decode(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('gb18030').decode(bytes) // most legacy Chinese zips come from Windows
  }
}

// JSZip keeps the uncompressed size from the central directory on its private _data; reading
// it saves decompressing every entry just to list sizes.
function knownSize(obj: JSZip.JSZipObject): number | null {
  const size = (obj as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
  return typeof size === 'number' ? size : null
}

export async function readZip(blob: Blob, encoding: NameEncoding = 'auto') {
  let legacyNames = false // a name without the UTF-8 flag that isn't plain ASCII
  const zip = await JSZip.loadAsync(blob, {
    decodeFileName: (raw) => {
      const bytes = raw as Uint8Array
      if (bytes.some((b) => b >= 0x80)) legacyNames = true
      return decodeName(bytes, encoding)
    },
  })
  const files = new Map<string, FileEntry>()
  const dirs = new Set<string>()
  const objs: JSZip.JSZipObject[] = []
  zip.forEach((_, obj) => objs.push(obj))
  for (const obj of objs) {
    const path = normalizePath(obj.name)
    if (!path) continue
    if (obj.dir) {
      dirs.add(path)
      continue
    }
    const size = knownSize(obj) ?? (await obj.async('uint8array')).length
    files.set(path, { path, size, date: fromZipDate(obj.date), source: obj })
  }
  return { files, dirs, legacyNames }
}

const blobCache = new WeakMap<JSZip.JSZipObject, Promise<Blob>>()

export function readEntry(entry: FileEntry): Promise<Blob> {
  const src = entry.source
  if (src instanceof Blob) return Promise.resolve(src)
  let p = blobCache.get(src)
  if (!p) {
    p = src.async('blob')
    blobCache.set(src, p)
    p.catch(() => blobCache.delete(src))
  }
  return p
}

// ---------- the open archive ----------
export function useArchive() {
  const isOpen = ref(false)
  const name = ref('archive.zip')
  const files = shallowRef(new Map<string, FileEntry>())
  const dirs = shallowRef(new Set<string>()) // explicit folders, so empty ones survive
  const dirty = ref(false)
  const legacyNames = ref(false)
  const encoding = ref<NameEncoding>('auto')
  const past = shallowRef<Snapshot[]>([])
  const future = shallowRef<Snapshot[]>([])
  let original: Blob | null = null // the zip as opened, for re-reading with another name encoding

  const allDirs = computed(() => {
    const out = new Set(dirs.value)
    for (const p of [...files.value.keys(), ...dirs.value]) for (const a of ancestors(p)) out.add(a)
    return out
  })
  const totalSize = computed(() => {
    let n = 0
    for (const f of files.value.values()) n += f.size
    return n
  })

  function reset(next: { files: Map<string, FileEntry>; dirs: Set<string> }, zipName: string) {
    files.value = next.files
    dirs.value = next.dirs
    name.value = zipName
    past.value = []
    future.value = []
    dirty.value = false
    isOpen.value = true
  }

  async function open(blob: Blob, zipName: string, enc: NameEncoding = 'auto') {
    const read = await readZip(blob, enc)
    original = blob
    encoding.value = enc
    legacyNames.value = read.legacyNames
    reset(read, zipName)
  }

  function create(zipName = 'archive.zip') {
    original = null
    legacyNames.value = false
    reset({ files: new Map(), dirs: new Set() }, zipName)
  }

  async function reopenWithEncoding(enc: NameEncoding) {
    if (original) await open(original, name.value, enc)
  }

  function close() {
    original = null
    isOpen.value = false
    files.value = new Map()
    dirs.value = new Set()
    past.value = []
    future.value = []
    dirty.value = false
  }

  function commit(nextFiles: Map<string, FileEntry>, nextDirs: Set<string>, label: string) {
    past.value = [...past.value.slice(-(HISTORY_LIMIT - 1)), { files: files.value, dirs: dirs.value, label }]
    future.value = []
    files.value = nextFiles
    dirs.value = nextDirs
    dirty.value = true
  }

  function undo(): string | null {
    const snap = past.value.at(-1)
    if (!snap) return null
    past.value = past.value.slice(0, -1)
    future.value = [...future.value, { files: files.value, dirs: dirs.value, label: snap.label }]
    files.value = snap.files
    dirs.value = snap.dirs
    dirty.value = true
    return snap.label
  }

  function redo(): string | null {
    const snap = future.value.at(-1)
    if (!snap) return null
    future.value = future.value.slice(0, -1)
    past.value = [...past.value, { files: files.value, dirs: dirs.value, label: snap.label }]
    files.value = snap.files
    dirs.value = snap.dirs
    dirty.value = true
    return snap.label
  }

  // Folders and files directly inside `dir`, folders first.
  function children(dir: string): Row[] {
    const prefix = dir ? `${dir}/` : ''
    const folders = new Map<string, Row>()
    const out: Row[] = []
    const folderRow = (child: string) => {
      let row = folders.get(child)
      if (!row) {
        row = { path: prefix + child, name: child, dir: true, size: 0, date: null, count: 0 }
        folders.set(child, row)
      }
      return row
    }
    for (const f of files.value.values()) {
      if (!f.path.startsWith(prefix)) continue
      const rest = f.path.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash < 0) {
        out.push({ path: f.path, name: rest, dir: false, size: f.size, date: f.date, count: 0, entry: f })
      } else {
        const row = folderRow(rest.slice(0, slash))
        row.size += f.size
        row.count++
      }
    }
    for (const d of allDirs.value) {
      if (d.startsWith(prefix) && d.length > prefix.length && !d.slice(prefix.length).includes('/')) {
        folderRow(d.slice(prefix.length))
      }
    }
    const cmp = (a: Row, b: Row) => collator.compare(a.name, b.name)
    return [...[...folders.values()].sort(cmp), ...out.sort(cmp)]
  }

  const exists = (path: string) => files.value.has(path) || allDirs.value.has(path)

  function addFiles(list: { path: string; blob: Blob; date?: Date }[], newDirs: string[] = [], label = `新增 ${list.length} 個檔案`) {
    const f = new Map(files.value)
    const d = new Set(dirs.value)
    for (const { path, blob, date } of list) {
      const p = normalizePath(path)
      if (p) f.set(p, { path: p, size: blob.size, date: date ?? new Date(), source: blob })
    }
    for (const dir of newDirs) {
      const p = normalizePath(dir)
      if (p) d.add(p)
    }
    commit(f, d, label)
  }

  function writeFile(path: string, blob: Blob) {
    const f = new Map(files.value)
    f.set(path, { path, size: blob.size, date: new Date(), source: blob })
    commit(f, dirs.value, `編輯「${baseName(path)}」`)
  }

  function mkdir(path: string) {
    const d = new Set(dirs.value)
    d.add(path)
    commit(files.value, d, `新增資料夾「${baseName(path)}」`)
  }

  function remove(rows: { path: string; dir: boolean }[]) {
    const f = new Map(files.value)
    const d = new Set(dirs.value)
    for (const { path, dir } of rows) {
      if (dir) {
        const prefix = `${path}/`
        for (const k of [...f.keys()]) if (k.startsWith(prefix)) f.delete(k)
        for (const k of [...d]) if (k === path || k.startsWith(prefix)) d.delete(k)
      } else {
        f.delete(path)
      }
      // Deleting the last thing in a folder shouldn't make the folder itself vanish.
      const parent = parentOf(path)
      if (parent) d.add(parent)
    }
    const label = rows.length === 1 ? `刪除「${baseName(rows[0].path)}」` : `刪除 ${rows.length} 個項目`
    commit(f, d, label)
  }

  // Moves a file or a whole folder; `to` may point into another folder.
  function rename(from: { path: string; dir: boolean }, to: string) {
    const f = new Map(files.value)
    const d = new Set(dirs.value)
    if (from.dir) {
      const prefix = `${from.path}/`
      for (const [k, v] of files.value) {
        if (!k.startsWith(prefix)) continue
        const p = `${to}/${k.slice(prefix.length)}`
        f.delete(k)
        f.set(p, { ...v, path: p })
      }
      for (const k of dirs.value) {
        if (k === from.path) { d.delete(k); d.add(to) }
        else if (k.startsWith(prefix)) { d.delete(k); d.add(`${to}/${k.slice(prefix.length)}`) }
      }
      d.add(to)
    } else {
      const v = f.get(from.path)
      if (!v) return
      f.delete(from.path)
      f.set(to, { ...v, path: to })
    }
    commit(f, d, `重新命名「${baseName(from.path)}」`)
  }

  // Replaces everything with another zip's content (e.g. the simplified/traditional conversion).
  async function replaceWith(blob: Blob, label: string) {
    const read = await readZip(blob)
    commit(read.files, read.dirs, label)
  }

  // Adds another zip's content under `dir`, overwriting same-named files.
  async function mergeFrom(blob: Blob, dir: string, label: string) {
    const read = await readZip(blob)
    const f = new Map(files.value)
    const d = new Set(dirs.value)
    for (const v of read.files.values()) {
      const p = joinPath(dir, v.path)
      f.set(p, { ...v, path: p })
    }
    for (const k of read.dirs) d.add(joinPath(dir, k))
    commit(f, d, label)
  }

  async function generate(level: number, onProgress?: (percent: number) => void): Promise<Blob> {
    const zip = new JSZip()
    const now = toZipDate(new Date())
    for (const dir of [...allDirs.value].sort()) zip.file(`${dir}/`, null, { dir: true, date: now })
    for (const f of [...files.value.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      if (f.source instanceof Blob) {
        zip.file(f.path, f.source, { date: toZipDate(f.date), createFolders: false })
      } else {
        // Put the original object in as is: when the compression method matches, JSZip copies
        // its compressed bytes instead of inflating and deflating them again.
        zip.files[f.path] = f.source
      }
    }
    const blob = await zip.generateAsync(
      {
        type: 'blob',
        mimeType: 'application/zip',
        compression: level > 0 ? 'DEFLATE' : 'STORE',
        compressionOptions: { level: Math.max(1, level) },
      },
      (meta) => onProgress?.(meta.percent),
    )
    return blob
  }

  function markSaved() {
    dirty.value = false
  }

  return {
    isOpen, name, files, dirs, allDirs, totalSize, dirty, legacyNames, encoding,
    canUndo: computed(() => past.value.length > 0),
    canRedo: computed(() => future.value.length > 0),
    open, create, close, reopenWithEncoding, undo, redo, children, exists,
    addFiles, writeFile, mkdir, remove, rename, replaceWith, mergeFrom, generate, markSaved,
  }
}

export type Archive = ReturnType<typeof useArchive>
