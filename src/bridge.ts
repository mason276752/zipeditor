// Talks to the sibling tools on mason276752.github.io. They share an origin, so each one
// listens on a BroadcastChannel named after itself:
//
//   {type:'ping'}                         anyone → tool   "who's open?"
//   {type:'ready', id} / {type:'bye', id}  tool tab        announces itself / goes away
//   {type:'zip', to, id, file, from?, replyTo?, inReplyTo?}
//   {type:'files', to, id, files, from?}  delivery addressed to one tab, so two open copies
//                                         don't both act on it
//   {type:'received', id}                 that tab's ack
//
// replyTo {app, to} asks the receiver to send its result back to that tab instead of
// downloading it; the answer carries inReplyTo with the request's id.

export type Tool = 'paste2jpg' | 'ziptotaiwanzip' | 'upscale' | 'removebg' | 'audiospeed'

export const TOOLS: Record<Tool, { url: string; label: string; hint?: string }> = {
  paste2jpg: { url: '../paste2jpg/', label: 'Paste → JPG', hint: '轉成 JPG／WebP' },
  ziptotaiwanzip: { url: '../ziptotaiwanzip/', label: '簡繁轉換工具' },
  upscale: { url: '../upscale/', label: '圖片放大', hint: 'AI 放大 2 倍或 4 倍' },
  removebg: { url: '../removebg/', label: '去背', hint: 'AI 去除背景，可手動修補' },
  audiospeed: { url: '../audiospeed/', label: '音檔變速', hint: '加快或放慢，音高不變' },
}

// Tools that take loose files ({type:'files'}), by the kind of file they want.
export type FileKind = 'image' | 'audio'
export const FILE_TOOLS: Record<FileKind, Tool[]> = {
  image: ['paste2jpg', 'upscale', 'removebg'],
  audio: ['audiospeed'],
}

const SELF = 'zipeditor'

export interface ZipDelivery {
  id: string
  file: File
  from?: string
  inReplyTo?: string
}

export const bridgeSupported = typeof BroadcastChannel !== 'undefined'
export const tabId = crypto.randomUUID()
export const newId = () => crypto.randomUUID()

const peers = new Map<Tool, { channel: BroadcastChannel; tabs: Set<string> }>()

function peer(name: Tool) {
  let p = peers.get(name)
  if (!p) {
    const channel = new BroadcastChannel(name)
    const tabs = new Set<string>() // most recently announced last
    channel.addEventListener('message', (e: MessageEvent) => {
      const m = e.data
      if (m?.type === 'ready') {
        tabs.delete(m.id)
        tabs.add(m.id)
      } else if (m?.type === 'bye') {
        tabs.delete(m.id)
      }
    })
    channel.postMessage({ type: 'ping' })
    p = { channel, tabs }
    peers.set(name, p)
  }
  return p
}

// Resolves with the first message on `channel` that passes `test`, or null after `ms`.
function nextMessage(channel: BroadcastChannel, test: (m: any) => boolean, ms: number): Promise<any> {
  return new Promise((resolve) => {
    const finish = (m: unknown) => {
      clearTimeout(timer)
      channel.removeEventListener('message', onMessage)
      resolve(m)
    }
    const onMessage = (e: MessageEvent) => {
      if (e.data && test(e.data)) finish(e.data)
    }
    const timer = setTimeout(() => finish(null), ms)
    channel.addEventListener('message', onMessage)
  })
}

export type SendResult = 'sent' | 'blocked' | 'no-answer'

// Call synchronously from a click: if the tool isn't open, this opens it in a new tab, which
// popup blockers only allow inside the gesture. `build` makes the message once that's done.
export function send(target: Tool, build: () => Promise<Record<string, unknown> & { id: string }>): Promise<SendResult> {
  const p = peer(target)
  if (!p.tabs.size && !window.open(TOOLS[target].url, target)) return Promise.resolve('blocked')
  return (async () => {
    const msg = await build()
    // A tab we just opened may already have announced itself while `build` ran.
    let to = [...p.tabs].pop()
    if (!to) to = (await nextMessage(p.channel, (m) => m.type === 'ready', 30_000))?.id
    if (!to) return 'no-answer'
    const ack = nextMessage(p.channel, (m) => m.type === 'received' && m.id === msg.id, 5000)
    p.channel.postMessage({ ...msg, to, from: SELF })
    if (await ack) return 'sent'
    p.tabs.delete(to) // closed without 'bye'; the next send opens a fresh tab
    return 'no-answer'
  })()
}

export const replyAddress = { app: SELF, to: tabId }

// Announces this tab and hands zips addressed to it to `onZip`.
export function listen(onZip: (d: ZipDelivery) => void): () => void {
  if (!bridgeSupported) return () => {}
  for (const name of Object.keys(TOOLS) as Tool[]) peer(name) // learn which tools are already open
  const channel = new BroadcastChannel(SELF)
  const announce = () => channel.postMessage({ type: 'ready', id: tabId })
  const bye = () => channel.postMessage({ type: 'bye', id: tabId })
  const onShow = (e: PageTransitionEvent) => {
    if (e.persisted) announce()
  }
  channel.onmessage = (e: MessageEvent) => {
    const m = e.data
    if (m?.type === 'ping') {
      announce()
    } else if (m?.type === 'zip' && m.to === tabId && m.file instanceof File) {
      channel.postMessage({ type: 'received', id: m.id })
      onZip({ id: m.id, file: m.file, from: m.from, inReplyTo: m.inReplyTo })
    }
  }
  window.addEventListener('pagehide', bye)
  window.addEventListener('pageshow', onShow)
  announce()
  return () => {
    window.removeEventListener('pagehide', bye)
    window.removeEventListener('pageshow', onShow)
    bye()
    channel.close()
  }
}

export function toolLabel(from: string | undefined): string {
  return (from && TOOLS[from as Tool]?.label) || from || '其他分頁'
}
