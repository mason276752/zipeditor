// HEIC／HEIF：只有 Safari 能原生解碼；其他瀏覽器遇到時才載入 libheif（heic-to，WebAssembly，在本機執行）。
// 從 paste2jpg 的 index.html 搬過來；upscale、removebg、document-jpg、zipeditor 用的是同一份檔案。

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'mif2', 'msf1'])
export const HEIF_EXT = /\.(heic|heif|hif)$/i

/** 看 MIME、副檔名，都沒有就看檔頭的 ftyp brand。 */
async function isHeif(blob) {
  if (/^image\/hei[cf]/i.test(blob.type) || HEIF_EXT.test(blob.name || '')) return true
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  const text = String.fromCharCode(...head)
  return text.slice(4, 8) === 'ftyp' && HEIF_BRANDS.has(text.slice(8, 12))
}

/** 用 <img> 試解：解得開（Safari）縮圖就能直接顯示，不必轉。 */
async function decodesNatively(blob) {
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return true
  } catch {
    return false
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * 瀏覽器解不開的 HEIF 換成同名的 PNG（無損），其他檔案原樣傳回。
 * 換過之後縮圖、解碼都當一般圖片處理。
 *
 * @param {File} file
 * @returns {Promise<File>}
 */
export async function ensureDecodable(file) {
  if (!(await isHeif(file)) || (await decodesNatively(file))) return file
  const bitmap = await decodeHeif(file)
  const c = document.createElement('canvas')
  c.width = bitmap.width
  c.height = bitmap.height
  c.getContext('2d').drawImage(bitmap, 0, 0)
  bitmap.close()
  const png = await new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('圖片太大，瀏覽器無法轉換'))), 'image/png'),
  )
  c.width = c.height = 0 // 大畫布立刻釋放，不等 GC
  const name = `${(file.name || 'image').replace(/\.[^.]+$/, '')}.png`
  return new File([png], name, { type: 'image/png', lastModified: file.lastModified })
}

async function loadHeicTo() {
  try {
    return (await import('heic-to')).heicTo
  } catch (err) {
    throw new Error('HEIF 解碼器載入失敗，請檢查網路後再試一次', { cause: err })
  }
}

/** HEIF → ImageBitmap（libheif 已經依 irot／imir 轉正）。 */
async function decodeHeif(blob) {
  const heicTo = await loadHeicTo()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const fix = patchPaddedHeif(bytes)
  let bitmap
  try {
    bitmap = await heicTo({ blob: new Blob([bytes]), type: 'bitmap' })
  } catch (err) {
    throw new Error('無法解碼這張 HEIF：檔案可能已損壞，或使用了不支援的編碼', { cause: err })
  }
  if (!fix || bitmap.width !== fix.full.w || bitmap.height !== fix.full.h) return bitmap
  const { x, y, w, h } = fix.crop
  const cropped = await createImageBitmap(bitmap, x, y, w, h)
  bitmap.close()
  return cropped
}

/** hvcC 裡第一個 SPS 的畫面大小（套用 conformance window 裁切之後）。 */
function hevcOutputSize(hvcC) {
  let p = 22
  const arrays = hvcC[p++]
  for (let a = 0; a < arrays; a++) {
    const nalType = hvcC[p++] & 0x3f
    const count = (hvcC[p] << 8) | hvcC[p + 1]
    p += 2
    for (let i = 0; i < count; i++) {
      const len = (hvcC[p] << 8) | hvcC[p + 1]
      p += 2
      if (nalType === 33) return spsOutputSize(hvcC.subarray(p + 2, p + len)) // 跳過 NAL header
      p += len
    }
  }
  return null
}

function spsOutputSize(nal) {
  const rbsp = []
  for (let i = 0, zeros = 0; i < nal.length; i++) {
    if (zeros >= 2 && nal[i] === 3) { // emulation prevention byte
      zeros = 0
      continue
    }
    rbsp.push(nal[i])
    zeros = nal[i] === 0 ? zeros + 1 : 0
  }
  let bit = 0
  const skip = (n) => { bit += n }
  const u = (n) => {
    let v = 0
    while (n--) {
      if (bit >= rbsp.length * 8) throw new Error('SPS overrun')
      v = v * 2 + ((rbsp[bit >> 3] >> (7 - (bit & 7))) & 1)
      bit++
    }
    return v
  }
  const ue = () => {
    let z = 0
    while (!u(1)) z++
    return 2 ** z - 1 + u(z)
  }

  skip(4)
  const maxSubLayers = u(3)
  skip(1 + 96) // temporal_id_nesting ＋ general profile_tier_level
  const sub = []
  for (let i = 0; i < maxSubLayers; i++) sub.push([u(1), u(1)])
  if (maxSubLayers > 0) skip(2 * (8 - maxSubLayers))
  for (const [profile, level] of sub) skip((profile ? 88 : 0) + (level ? 8 : 0))
  ue() // sps_seq_parameter_set_id
  const chroma = ue()
  if (chroma === 3) skip(1)
  let w = ue()
  let h = ue()
  if (u(1)) {
    const subW = chroma === 1 || chroma === 2 ? 2 : 1
    const subH = chroma === 1 ? 2 : 1
    const [l, r, t, b] = [ue(), ue(), ue(), ue()]
    w -= subW * (l + r)
    h -= subH * (t + b)
  }
  return { w, h }
}

/**
 * 有些相機（Sony 遇過）把 HEVC 畫面補齊成 1920×1088 之類、又沒設 conformance window，
 * 'ispe' 卻寫 1920×1080。libheif 會拒絕（"Decoded image does not have the size signaled
 * in the file"），Apple 的解碼器則是直接裁掉。這裡照 Apple 的做法：把 'ispe' 就地改成
 * 實際編碼的大小，再回傳真正的畫面在轉正（irot／imir）之後的位置；沒這個問題就回傳 null。
 */
function patchPaddedHeif(bytes) {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const boxes = (start, end) => {
      const out = []
      for (let p = start; p + 8 <= end;) {
        let size = dv.getUint32(p)
        let hdr = 8
        if (size === 1) {
          size = Number(dv.getBigUint64(p + 8))
          hdr = 16
        } else if (size === 0) {
          size = end - p
        }
        if (size < hdr || p + size > end) break
        out.push({ type: String.fromCharCode(...bytes.subarray(p + 4, p + 8)), body: p + hdr, end: p + size })
        p += size
      }
      return out
    }
    const find = (list, type) => list.find((b) => b.type === type)

    const meta = find(boxes(0, bytes.length), 'meta')
    const metaKids = boxes(meta.body + 4, meta.end)
    const pitm = find(metaKids, 'pitm')
    const primary = bytes[pitm.body] === 0 ? dv.getUint16(pitm.body + 4) : dv.getUint32(pitm.body + 4)
    const iprp = find(metaKids, 'iprp')
    const iprpKids = boxes(iprp.body, iprp.end)
    const ipco = find(iprpKids, 'ipco')
    const ipma = find(iprpKids, 'ipma')
    const props = boxes(ipco.body, ipco.end)

    const version = bytes[ipma.body]
    const wide = bytes[ipma.body + 3] & 1
    let p = ipma.body + 4
    const entries = dv.getUint32(p)
    p += 4
    let result = null
    const patched = new Set()
    for (let i = 0; i < entries; i++) {
      const id = version < 1 ? dv.getUint16(p) : dv.getUint32(p)
      p += version < 1 ? 2 : 4
      const linked = []
      for (let n = bytes[p++]; n > 0; n--) {
        const idx = wide ? dv.getUint16(p) & 0x7fff : bytes[p] & 0x7f
        p += wide ? 2 : 1
        if (props[idx - 1]) linked.push(props[idx - 1])
      }
      const hvcC = find(linked, 'hvcC')
      const ispe = find(linked, 'ispe')
      if (!hvcC || !ispe || find(linked, 'clap')) continue
      const coded = hevcOutputSize(bytes.subarray(hvcC.body, hvcC.end))
      const w = dv.getUint32(ispe.body + 4)
      const h = dv.getUint32(ispe.body + 8)
      if (!coded || coded.w < w || coded.h < h || (coded.w === w && coded.h === h)) continue
      if (!patched.has(ispe)) {
        dv.setUint32(ispe.body + 4, coded.w)
        dv.setUint32(ispe.body + 8, coded.h)
        patched.add(ispe)
      }
      if (id !== primary) continue

      // 補齊的部分在編碼畫面的右邊／下面；跟著轉正的步驟算出它最後在哪。
      let W = coded.w
      let H = coded.h
      let r = { x: 0, y: 0, w, h }
      for (const prop of linked) {
        if (prop.type === 'irot') {
          for (let k = bytes[prop.body] & 3; k > 0; k--) { // 每次逆時針 90°
            r = { x: r.y, y: W - r.x - r.w, w: r.h, h: r.w }
            ;[W, H] = [H, W]
          }
        } else if (prop.type === 'imir') {
          if (bytes[prop.body] & 1) r.y = H - r.y - r.h // 水平軸：上下翻
          else r.x = W - r.x - r.w // 垂直軸：左右翻
        }
      }
      result = { full: { w: W, h: H }, crop: r }
    }
    return result
  } catch {
    return null // 結構不如預期：照原樣解碼，有問題讓 libheif 回報
  }
}
