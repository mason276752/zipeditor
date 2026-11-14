export type Kind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'other'

const TYPES: Record<string, [Kind, string]> = {
  png: ['image', 'image/png'],
  jpg: ['image', 'image/jpeg'],
  jpeg: ['image', 'image/jpeg'],
  gif: ['image', 'image/gif'],
  webp: ['image', 'image/webp'],
  avif: ['image', 'image/avif'],
  bmp: ['image', 'image/bmp'],
  ico: ['image', 'image/x-icon'],
  svg: ['image', 'image/svg+xml'],
  heic: ['image', 'image/heic'],
  heif: ['image', 'image/heif'],
  mp4: ['video', 'video/mp4'],
  m4v: ['video', 'video/mp4'],
  mov: ['video', 'video/quicktime'],
  webm: ['video', 'video/webm'],
  ogv: ['video', 'video/ogg'],
  mp3: ['audio', 'audio/mpeg'],
  m4a: ['audio', 'audio/mp4'],
  aac: ['audio', 'audio/aac'],
  wav: ['audio', 'audio/wav'],
  ogg: ['audio', 'audio/ogg'],
  oga: ['audio', 'audio/ogg'],
  opus: ['audio', 'audio/ogg'],
  flac: ['audio', 'audio/flac'],
  pdf: ['pdf', 'application/pdf'],
  json: ['text', 'application/json'],
  html: ['text', 'text/html'],
  htm: ['text', 'text/html'],
  xml: ['text', 'application/xml'],
  css: ['text', 'text/css'],
  js: ['text', 'text/javascript'],
  mjs: ['text', 'text/javascript'],
  csv: ['text', 'text/csv'],
}

const TEXT_EXT = new Set(
  ('txt md markdown cjs ts tsx jsx vue svelte scss sass less tsv yml yaml toml ini cfg conf log ' +
    'sh bash zsh fish bat cmd ps1 py rb go rs java kt kts swift c h cc cpp hpp cs php pl lua r dart ' +
    'sql srt vtt ass ssa lrc env gitignore gitattributes editorconfig properties gradle tex rst ' +
    'opf ncx xhtml plist').split(' '),
)

const ext = (name: string) => {
  const m = /\.([^./]+)$/.exec(name)
  return m ? m[1].toLowerCase() : ''
}

export function kindOf(name: string): Kind {
  const e = ext(name)
  if (TYPES[e]) return TYPES[e][0]
  return TEXT_EXT.has(e) ? 'text' : 'other'
}

export function mimeOf(name: string): string {
  const e = ext(name)
  if (TYPES[e]) return TYPES[e][1]
  return TEXT_EXT.has(e) ? 'text/plain' : 'application/octet-stream'
}

// Extension-less files (README, LICENSE, Makefile…) count as text if they look like UTF-8.
export async function looksLikeText(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 8192).arrayBuffer())
  if (head.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true })
    return true
  } catch {
    return false
  }
}
