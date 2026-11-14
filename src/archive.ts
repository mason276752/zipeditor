import JSZip from 'jszip'
import { computed, ref, shallowRef } from 'vue'

export interface FileEntry {
  // Which file this is, kept through renames and through a tool overwriting it, so changes are
  // matched against the original even when the name changed (photo.png → photo.jpg).
  id: number
  path: string
  size: number
  date: Date
  // Untouched entries keep their JSZipObject so the original compressed bytes can be reused.
  source: Blob | JSZip.JSZipObject
}

// What happened to a file since the zip was last downloaded or the changes were accepted:
// U new, M modified, D deleted.
export type Change = 'U' | 'M' | 'D'

let ids = 0
const newEntryId = () => ++ids

export interface Row {
  path: string
  name: string
  dir: boolean
  size: number
  date: Date | null
  count: number // files inside, for folders
  entry?: FileEntry
  // For a file, what happened to it; for a folder, what happened inside (M when mixed).
  change?: Change
  // Only in the baseline: a deleted file, or a folder that no longer exists. Shown struck out.
  gone?: boolean
  // For a modified or deleted file, how it was at the baseline (its name may have been different).
  base?: FileEntry
}

// One step of the path above the file list: a zip (the open one, or one it sits inside) or a folder.
export interface Crumb {
  name: string
  depth: number // which zip: 0 is the outermost
  path: string // folder within that zip, '' for its root
  zip: boolean
  here: boolean
}

export type NameEncoding = 'auto' | 'utf-8' | 'gb18030' | 'big5' | 'shift_jis'

interface Snapshot {
  files: Map<string, FileEntry>
  dirs: Set<string>
  label: string
  mergeKey?: string
}

// A password the zip is saved with. AES-256 is safe but needs 7-Zip or similar; the traditional
// ZipCrypto opens in Windows and macOS out of the box but is easy to break.
export type Encryption = 'aes' | 'zipcrypto'
export interface Protection {
  password: string
  encryption: Encryption
}

// The zip is encrypted and no password was given, or the one given is wrong.
export class PasswordError extends Error {}

// Everything about an open zip, set aside while a zip inside it is open (see suspend / resume).
export interface ArchiveState {
  name: string
  files: Map<string, FileEntry>
  dirs: Set<string>
  dirty: boolean
  legacyNames: boolean
  encoding: NameEncoding
  past: Snapshot[]
  future: Snapshot[]
  baseFiles: Map<string, FileEntry>
  baseDirs: Set<string>
  original: Blob | null
  protection: Protection | null
  doc: number
}

let docs = 0 // ids for opened zips, never reused, so a late tool result can't land in the wrong one

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

// JSZip can't decrypt, so password-protected zips go through zip.js (loaded only for them).
export async function readZip(blob: Blob, encoding: NameEncoding = 'auto', password?: string) {
  try {
    return { ...(await readPlainZip(blob, encoding)), protection: null }
  } catch (err) {
    if (!/encrypted/i.test(String((err as Error)?.message))) throw err
  }
  return readEncryptedZip(blob, encoding, password)
}

async function readPlainZip(blob: Blob, encoding: NameEncoding) {
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
    files.set(path, { id: newEntryId(), path, size, date: fromZipDate(obj.date), source: obj })
  }
  return { files, dirs, legacyNames }
}

// Decrypts every entry up front (into Blobs); the password is kept to save with again.
async function readEncryptedZip(blob: Blob, encoding: NameEncoding, password: string | undefined) {
  if (!password) throw new PasswordError('這個 ZIP 有密碼')
  const zipjs = await import('@zip.js/zip.js')
  const reader = new zipjs.ZipReader(new zipjs.BlobReader(blob))
  try {
    let legacyNames = false
    let encryption: Encryption = 'aes'
    const files = new Map<string, FileEntry>()
    const dirs = new Set<string>()
    for (const e of await reader.getEntries()) {
      if (!e.filenameUTF8 && e.rawFilename.some((b) => b >= 0x80)) legacyNames = true
      const path = normalizePath(e.filenameUTF8 ? e.filename : decodeName(e.rawFilename, encoding))
      if (!path) continue
      if (e.directory) {
        dirs.add(path)
        continue
      }
      if (e.encrypted && e.zipCrypto) encryption = 'zipcrypto'
      const data = await e.getData(new zipjs.BlobWriter(), { password })
      files.set(path, { id: newEntryId(), path, size: data.size, date: e.lastModDate, source: data })
    }
    return { files, dirs, legacyNames, protection: { password, encryption } }
  } catch (err) {
    if ((err as Error)?.message === zipjs.ERR_INVALID_PASSWORD) throw new PasswordError('密碼不對')
    throw err
  } finally {
    await reader.close()
  }
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
  const protection = shallowRef<Protection | null>(null) // saved with this password
  const past = shallowRef<Snapshot[]>([])
  const future = shallowRef<Snapshot[]>([])
  // The state at the last download (or open, or "accept"): changes are shown against it.
  const baseFiles = shallowRef(new Map<string, FileEntry>())
  const baseDirs = shallowRef(new Set<string>())
  let original: Blob | null = null // the zip as opened, for re-reading with another name encoding
  let doc = 0 // which zip this is (see `docs`)

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

  // Files are matched with the baseline by id: modified means the content was replaced or the
  // file was renamed (or both, like a tool turning photo.png into photo.jpg).
  const byId = (m: Map<string, FileEntry>) => new Map([...m.values()].map((e) => [e.id, e]))
  const currentById = computed(() => byId(files.value))
  const baseById = computed(() => byId(baseFiles.value))
  const changes = computed(() => {
    const out = new Map<string, Change>()
    for (const [p, f] of files.value) {
      const b = baseById.value.get(f.id)
      if (!b) out.set(p, 'U')
      else if (b.path !== p || b.source !== f.source) out.set(p, 'M')
    }
    for (const b of baseFiles.value.values()) {
      if (!currentById.value.has(b.id) && !out.has(b.path)) out.set(b.path, 'D')
    }
    return out
  })

  // How a file was at the baseline: by id for a file that's there now, by path for a deleted one.
  function baseOf(path: string): FileEntry | undefined {
    const f = files.value.get(path)
    return f ? baseById.value.get(f.id) : baseFiles.value.get(path)
  }

  // The id for a file written at `path`: the one already there, else the deleted file that was
  // there at the baseline (so deleting and re-adding a file counts as modifying it), else new.
  function idFor(path: string): number {
    const here = files.value.get(path) ?? baseFiles.value.get(path)
    return here && (files.value.get(path) || !currentById.value.has(here.id)) ? here.id : newEntryId()
  }

  // Puts files back the way they were at the baseline: everything at or under each path, files
  // renamed into it go back to their old names, deleted ones come back, new ones go away.
  function revert(paths: string[], label: string) {
    const f = new Map(files.value)
    const d = new Set(dirs.value)
    for (const root of paths) {
      const under = (p: string) => !root || p === root || p.startsWith(`${root}/`)
      for (const [p, e] of files.value) {
        if (!under(p)) continue
        f.delete(p)
        const b = baseById.value.get(e.id)
        if (b) f.set(b.path, b)
      }
      for (const b of baseFiles.value.values()) if (under(b.path) && !currentById.value.has(b.id)) f.set(b.path, b)
      for (const x of dirs.value) if (under(x) && !baseDirs.value.has(x)) d.delete(x)
      for (const x of baseDirs.value) if (under(x)) d.add(x)
    }
    commit(f, d, label)
  }
  // Folders that came or went with no files in them (made with 新資料夾, or removed while empty).
  // Folders with files are already covered by their files' changes.
  const dirChanges = computed(() => {
    const out = new Map<string, Change>()
    const now = new Set([...files.value.keys()].flatMap(ancestors))
    const before = new Set([...baseFiles.value.keys()].flatMap(ancestors))
    for (const d of allDirs.value) if (!baseDirs.value.has(d) && !now.has(d)) out.set(d, 'U')
    for (const d of baseDirs.value) if (!allDirs.value.has(d) && !before.has(d)) out.set(d, 'D')
    return out
  })
  const changeCount = computed(() => {
    const n = { U: 0, M: 0, D: 0, total: 0 }
    for (const c of [...changes.value.values(), ...dirChanges.value.values()]) {
      n[c]++
      n.total++
    }
    return n
  })

  // Makes the current state the baseline, so nothing shows as changed.
  function acceptChanges() {
    baseFiles.value = files.value
    baseDirs.value = new Set(allDirs.value)
  }

  function reset(next: { files: Map<string, FileEntry>; dirs: Set<string> }, zipName: string) {
    doc = ++docs
    files.value = next.files
    dirs.value = next.dirs
    name.value = zipName
    past.value = []
    future.value = []
    dirty.value = false
    isOpen.value = true
    acceptChanges()
  }

  // Throws PasswordError when the zip needs a password (or a different one).
  async function open(blob: Blob, zipName: string, enc: NameEncoding = 'auto', password?: string) {
    const read = await readZip(blob, enc, password)
    original = blob
    encoding.value = enc
    legacyNames.value = read.legacyNames
    protection.value = read.protection
    reset(read, zipName)
  }

  function create(zipName = 'archive.zip') {
    original = null
    protection.value = null
    legacyNames.value = false
    reset({ files: new Map(), dirs: new Set() }, zipName)
  }

  async function reopenWithEncoding(enc: NameEncoding) {
    if (original) await open(original, name.value, enc, protection.value?.password)
  }

  // Changing the password is a change to save, like editing a file.
  function setProtection(p: Protection | null) {
    protection.value = p
    dirty.value = true
  }

  function close() {
    doc = ++docs
    original = null
    protection.value = null
    isOpen.value = false
    files.value = new Map()
    dirs.value = new Set()
    past.value = []
    future.value = []
    dirty.value = false
    acceptChanges()
  }

  // Consecutive commits with the same `mergeKey` (a tool syncing its results back) undo as one step.
  function commit(nextFiles: Map<string, FileEntry>, nextDirs: Set<string>, label: string, mergeKey?: string) {
    const merge = mergeKey && past.value.at(-1)?.mergeKey === mergeKey && !future.value.length
    if (!merge) past.value = [...past.value.slice(-(HISTORY_LIMIT - 1)), { files: files.value, dirs: dirs.value, label, mergeKey }]
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
        const change = changes.value.get(f.path)
        out.push({
          path: f.path, name: rest, dir: false, size: f.size, date: f.date, count: 0, entry: f, change,
          base: change === 'M' ? baseById.value.get(f.id) : undefined,
        })
      } else {
        const row = folderRow(rest.slice(0, slash))
        row.size += f.size
        row.count++
      }
    }
    const isChild = (d: string) => d.startsWith(prefix) && d.length > prefix.length && !d.slice(prefix.length).includes('/')
    for (const d of allDirs.value) if (isChild(d)) folderRow(d.slice(prefix.length))
    const existing = new Set(folders.keys())

    // Changes since the baseline: deleted files stay listed until accepted, and a folder shows
    // what happened inside it (a new empty folder counts as new).
    for (const [p, c] of changes.value) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash >= 0) {
        const row = folderRow(rest.slice(0, slash))
        row.change = row.change && row.change !== c ? 'M' : c
      } else if (c === 'D') {
        const b = baseFiles.value.get(p)!
        out.push({ path: p, name: rest, dir: false, size: b.size, date: b.date, count: 0, change: 'D', gone: true, base: b })
      }
    }
    for (const d of baseDirs.value) if (isChild(d)) folderRow(d.slice(prefix.length))
    for (const [child, row] of folders) {
      if (!existing.has(child)) {
        row.gone = true
        row.change = 'D'
      } else if (!row.change && !baseDirs.value.has(row.path)) {
        row.change = 'U'
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
      if (p) f.set(p, { id: idFor(p), path: p, size: blob.size, date: date ?? new Date(), source: blob })
    }
    for (const dir of newDirs) {
      const p = normalizePath(dir)
      if (p) d.add(p)
    }
    commit(f, d, label)
  }

  // A result another tool sent back overwrites the file it was made from (`replaces`), renamed to
  // `path` when the extension changed. It stays the same file, so it shows as modified.
  function putResult(path: string, blob: Blob, replaces: string, label: string, mergeKey: string) {
    const f = new Map(files.value)
    const id = files.value.get(replaces)?.id ?? idFor(path)
    f.delete(replaces)
    f.set(path, { id, path, size: blob.size, date: new Date(), source: blob })
    commit(f, dirs.value, label, mergeKey)
  }

  function writeFile(path: string, blob: Blob, label = `編輯「${baseName(path)}」`) {
    const f = new Map(files.value)
    f.set(path, { id: idFor(path), path, size: blob.size, date: new Date(), source: blob })
    commit(f, dirs.value, label)
  }

  // The whole state of the open zip, to put back with `resume` (a zip inside it is opened meanwhile).
  function suspend(): ArchiveState {
    return {
      name: name.value, files: files.value, dirs: dirs.value, dirty: dirty.value, legacyNames: legacyNames.value,
      encoding: encoding.value, past: past.value, future: future.value, baseFiles: baseFiles.value,
      baseDirs: baseDirs.value, original, protection: protection.value, doc,
    }
  }

  function resume(s: ArchiveState) {
    name.value = s.name
    files.value = s.files
    dirs.value = s.dirs
    dirty.value = s.dirty
    legacyNames.value = s.legacyNames
    encoding.value = s.encoding
    past.value = s.past
    future.value = s.future
    baseFiles.value = s.baseFiles
    baseDirs.value = s.baseDirs
    original = s.original
    protection.value = s.protection
    doc = s.doc
    isOpen.value = true
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
  // Same-named files keep their ids, so they show as modified rather than deleted and new.
  async function replaceWith(blob: Blob, label: string) {
    const read = await readZip(blob)
    const f = new Map([...read.files].map(([p, v]) => [p, { ...v, id: idFor(p) }]))
    commit(f, read.dirs, label)
  }

  // Adds another zip's content under `dir`, overwriting same-named files.
  async function mergeFrom(blob: Blob, dir: string, label: string) {
    const read = await readZip(blob)
    const f = new Map(files.value)
    const d = new Set(dirs.value)
    for (const v of read.files.values()) {
      const p = joinPath(dir, v.path)
      f.set(p, { ...v, id: idFor(p), path: p })
    }
    for (const k of read.dirs) d.add(joinPath(dir, k))
    commit(f, d, label)
  }

  // `encrypt` false leaves the password out, for handing the zip to another tool.
  async function generate(level: number, onProgress?: (percent: number) => void, encrypt = true): Promise<Blob> {
    if (protection.value && encrypt) return generateEncrypted(protection.value, level, onProgress)
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

  // With a password the whole zip is written by zip.js; nothing can be copied over as is.
  async function generateEncrypted(p: Protection, level: number, onProgress?: (percent: number) => void) {
    const zipjs = await import('@zip.js/zip.js')
    const writer = new zipjs.ZipWriter(new zipjs.BlobWriter('application/zip'), {
      password: p.password, zipCrypto: p.encryption === 'zipcrypto', encryptionStrength: 3, level,
    })
    for (const dir of [...allDirs.value].sort()) await writer.add(`${dir}/`, undefined, { directory: true })
    const list = [...files.value.values()].sort((a, b) => (a.path < b.path ? -1 : 1))
    for (const [i, f] of list.entries()) {
      await writer.add(f.path, new zipjs.BlobReader(await readEntry(f)), { lastModDate: f.date })
      onProgress?.(((i + 1) / list.length) * 100)
    }
    return writer.close()
  }

  function markSaved() {
    dirty.value = false
    acceptChanges()
  }

  return {
    isOpen, name, files, dirs, allDirs, totalSize, dirty, legacyNames, encoding, protection, changes, changeCount, acceptChanges,
    setProtection,
    canUndo: computed(() => past.value.length > 0),
    canRedo: computed(() => future.value.length > 0),
    docId: () => doc,
    baseOf, revert,
    open, create, close, reopenWithEncoding, suspend, resume, undo, redo, children, exists,
    addFiles, writeFile, putResult, mkdir, remove, rename, replaceWith, mergeFrom, generate, markSaved,
  }
}

export type Archive = ReturnType<typeof useArchive>
