const pad = (n: number) => String(n).padStart(2, '0')

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(n < 10485760 ? 2 : 1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}

export function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function timeStamp(): string {
  const d = new Date()
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export interface Picked {
  files: { path: string; file: File }[]
  dirs: string[]
}

// Files from a dropped DataTransfer, walking into dropped folders.
export function droppedFiles(dt: DataTransfer): Promise<Picked> {
  // Entries must be taken synchronously, while the drop event is still being dispatched.
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e)
  if (!entries.length) return Promise.resolve({ files: [...dt.files].map((file) => ({ path: file.name, file })), dirs: [] })

  const out: Picked = { files: [], dirs: [] }
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej))
      out.files.push({ path: prefix + entry.name, file })
      return
    }
    const dir = prefix + entry.name
    out.dirs.push(dir)
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    for (;;) {
      // readEntries hands out batches (100 at a time in Chrome) until it returns none.
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
      if (!batch.length) break
      for (const e of batch) await walk(e, `${dir}/`)
    }
  }
  return (async () => {
    for (const e of entries) await walk(e, '')
    return out
  })()
}

// Files from <input webkitdirectory> carry their folder in webkitRelativePath.
export function pickedFiles(list: FileList): Picked {
  return { files: [...list].map((file) => ({ path: file.webkitRelativePath || file.name, file })), dirs: [] }
}
