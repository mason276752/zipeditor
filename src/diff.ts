// Line diff for comparing a text file with its original.

export interface DiffLine {
  op: ' ' | '-' | '+'
  text: string
  a?: number // line number in the original
  b?: number // line number now
}

// A run of unchanged lines folded away between hunks.
export interface DiffGap {
  skip: number
}

const MAX_EDITS = 2000
const CONTEXT = 3

// Myers' algorithm on what's left after the common start and end are cut off. With more than
// MAX_EDITS edits it stops looking and shows the middle as all removed, then all added.
export function diffLines(a: string[], b: string[]): DiffLine[] {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const midA = a.slice(pre, a.length - suf)
  const midB = b.slice(pre, b.length - suf)
  const mid = myers(midA, midB) ?? [
    ...midA.map((text) => ({ op: '-' as const, text })),
    ...midB.map((text) => ({ op: '+' as const, text })),
  ]
  const ops = [
    ...a.slice(0, pre).map((text) => ({ op: ' ' as const, text })),
    ...mid,
    ...a.slice(a.length - suf).map((text) => ({ op: ' ' as const, text })),
  ]
  let i = 0
  let j = 0
  return ops.map((o) => ({
    ...o,
    a: o.op === '+' ? undefined : ++i,
    b: o.op === '-' ? undefined : ++j,
  }))
}

function myers(a: string[], b: string[]): { op: DiffLine['op']; text: string }[] | null {
  const n = a.length
  const m = b.length
  // trace[d][k + d] is the furthest x reached on diagonal k with d edits.
  const trace: Int32Array[] = []
  let found = false
  for (let d = 0; d <= Math.min(n + m, MAX_EDITS) && !found; d++) {
    const prev = trace[d - 1]
    const cur = new Int32Array(2 * d + 1)
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (d === 0) x = 0
      else if (k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1])) x = prev[k + 1 + d - 1]
      else x = prev[k - 1 + d - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      cur[k + d] = x
      if (x >= n && y >= m) found = true
    }
    trace.push(cur)
  }
  if (!found) return null

  const out: { op: DiffLine['op']; text: string }[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1]
    const k = x - y
    const down = k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1])
    const pk = down ? k + 1 : k - 1
    const px = prev[pk + d - 1]
    const py = px - pk
    while (x > px + (down ? 0 : 1) && y > py + (down ? 1 : 0)) {
      out.push({ op: ' ', text: a[x - 1] })
      x--
      y--
    }
    if (down) out.push({ op: '+', text: b[--y] })
    else out.push({ op: '-', text: a[--x] })
  }
  while (x > 0 && y > 0) {
    out.push({ op: ' ', text: a[x - 1] })
    x--
    y--
  }
  return out.reverse()
}

// Keeps CONTEXT unchanged lines around each change and folds the rest into gaps.
export function hunks(lines: DiffLine[]): (DiffLine | DiffGap)[] {
  const keep = new Uint8Array(lines.length)
  lines.forEach((l, i) => {
    if (l.op === ' ') return
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) keep[j] = 1
  })
  const out: (DiffLine | DiffGap)[] = []
  let skip = 0
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skip) out.push({ skip })
      skip = 0
      out.push(l)
    } else {
      skip++
    }
  })
  if (skip) out.push({ skip })
  return out
}
