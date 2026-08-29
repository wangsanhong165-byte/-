/**
 * Minimal PKG container reader + scene embedded-video extractor.
 *
 * Enough of the Wallpaper Engine scene.pkg format (public RePKG/lwe reverse
 * engineering, format logic ported from dsh-wallpaper-engine's pkg-extract.js,
 * MIT — github.com/elysia395/dsh-wallpaper-engine) to:
 *   - parse the PKGVxxxx entry index
 *   - decompress LZ4 block-chain entries
 *   - detect video-texture TEX containers (mip0 starts with an MP4 ftyp box)
 *   - return the embedded MP4 bytes for hardware-decoded <video> playback
 *   - detect embedded JPEG payloads (photographic scenes) for static preview
 *
 * Deliberately NOT included: full DXT/BC7 texture decode, puppet meshes,
 * particle systems — the full renderer remains a future phase.
 */

class Reader {
  constructor(data) {
    this.data = data
    this.pos = 0
  }
  u8() { this.need(1); return this.data[this.pos++] }
  i32() { this.need(4); const v = this.data.readInt32LE(this.pos); this.pos += 4; return v }
  u32() { this.need(4); const v = this.data.readUInt32LE(this.pos); this.pos += 4; return v }
  u64() { this.need(8); const v = this.data.readBigUInt64LE(this.pos); this.pos += 8; return v }
  need(n) {
    if (this.pos + n > this.data.length) {
      throw new Error('pkg: unexpected end of data')
    }
  }
  bytes(n) {
    this.need(n)
    const out = this.data.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
  sizedString(max) {
    const len = this.u32()
    if (len < 0 || len > max) throw new Error('pkg: string length out of bounds')
    return Buffer.from(this.bytes(len)).toString('utf8')
  }
  get remaining() { return this.data.length - this.pos }
}

/** LZ4 block decompression (the format PKG entries use internally). */
function lz4DecompressBlock(src, dstSize) {
  const dst = Buffer.allocUnsafe(dstSize)
  let sPos = 0
  let dPos = 0
  while (sPos < src.length) {
    const token = src[sPos++]
    let literalLen = token >> 4
    if (literalLen === 15) {
      let add
      do { add = src[sPos++]; literalLen += add } while (add === 255)
    }
    if (literalLen > 0) {
      src.copy(dst, dPos, sPos, sPos + literalLen)
      sPos += literalLen
      dPos += literalLen
    }
    if (sPos >= src.length) break
    const offset = src[sPos++] | (src[sPos++] << 8)
    let matchLen = (token & 15) + 4
    if ((token & 15) === 15) {
      let add
      do { add = src[sPos++]; matchLen += add } while (add === 255)
    }
    let mPos = dPos - offset
    if (mPos < 0 || dPos + matchLen > dst.length) throw new Error('pkg: corrupt lz4 match')
    // Overlapping copies must go byte-by-byte (classic LZ4 semantics).
    for (let i = 0; i < matchLen; i++) dst[dPos++] = dst[mPos++]
  }
  if (dPos !== dstSize) throw new Error('pkg: lz4 size mismatch')
  return dst
}

function probeCompressedEntry(data, abs, length) {
  // Compressed entries start with u64 originalSize then (uncomp,comp) block
  // pairs; verify the chain sums exactly to the declared size.
  if (abs + 8 > data.length) return null
  const view = new DataView(data.buffer, data.byteOffset + abs, Math.min(length, data.length - abs))
  const originalSize = Number(view.getBigUint64(0, true))
  if (originalSize <= 0 || originalSize > 1 << 30) return null
  let pos = 8
  let total = 0
  while (pos + 8 <= view.byteLength) {
    const uncomp = view.getInt32(pos, true)
    const comp = view.getInt32(pos + 4, true)
    if (uncomp <= 0 || comp <= 0 || pos + 8 + comp > view.byteLength) return null
    total += uncomp
    pos += 8 + comp
  }
  return total === originalSize && pos === view.byteLength ? originalSize : null
}

/** Parse a PKG container (magic PKGVxxxx) → entry index. */
function parsePkg(data) {
  const r = new Reader(data)
  const magic = r.sizedString(32)
  if (!/^PKGV\d{4}$/.test(magic)) throw new Error(`pkg: bad magic '${magic}'`)
  const count = r.i32()
  if (count < 0 || count > 1048576) throw new Error(`pkg: invalid entry count ${count}`)
  const index = []
  for (let i = 0; i < count; i++) {
    index.push({ path: r.sizedString(1024), offset: r.u32(), length: r.u32() })
  }
  const dataStart = r.pos
  return index.map(({ path: entryPath, offset, length }) => {
    const abs = dataStart + offset
    if (abs + length > data.byteLength) throw new Error(`pkg: entry '${entryPath}' out of bounds`)
    const originalSize = probeCompressedEntry(data, abs, length)
    return originalSize === null
      ? { path: entryPath, offset: abs, compressedSize: length, size: length, flags: 0 }
      : { path: entryPath, offset: abs, compressedSize: length, size: originalSize, flags: 1 }
  })
}

function readPkgEntry(data, entry) {
  const abs = entry.offset
  if (abs < 0 || abs + entry.compressedSize > data.byteLength) {
    throw new Error(`pkg: entry '${entry.path}' out of bounds`)
  }
  if ((entry.flags & 1) === 0) return data.slice(abs, abs + entry.compressedSize)
  const r = new Reader(data.subarray(abs, abs + entry.compressedSize))
  if (r.u64() !== BigInt(entry.size)) throw new Error(`pkg: entry '${entry.path}' size mismatch`)
  const out = Buffer.allocUnsafe(entry.size)
  let written = 0
  while (written < entry.size) {
    const uncomp = r.i32()
    const comp = r.i32()
    if (uncomp <= 0 || comp <= 0 || written + uncomp > entry.size) {
      throw new Error(`pkg: corrupt compressed entry '${entry.path}'`)
    }
    out.set(lz4DecompressBlock(r.bytes(comp), uncomp), written)
    written += uncomp
  }
  if (r.remaining !== 0) throw new Error(`pkg: corrupt compressed entry '${entry.path}'`)
  return out
}

/** True when a TEX container's first mipmap payload is a video texture. */
function texMip0IsMp4(raw) {
  try {
    // TEX header: TEXV0005 version block, TEXI0001 info block, then mipmaps
    // (TEXB0001..4). We only need to FIND the ftyp box near the payload start;
    // scanning the first 64KB for the MP4 signature is robust across layouts.
    const scan = Math.min(raw.length, 65536)
    for (let i = 0; i + 8 <= scan; i++) {
      if (
        raw[i] === 0x66 && raw[i + 1] === 0x74
        && raw[i + 2] === 0x79 && raw[i + 3] === 0x70
      ) {
        const boxSize = (raw[i - 4] << 24) | (raw[i - 3] << 16) | (raw[i - 2] << 8) | raw[i - 1]
        if (boxSize >= 12 && boxSize <= raw.length) {
          return raw.subarray(i - 4)
        }
      }
    }
  } catch { /* not a video TEX */ }
  return null
}

function isJpegPayload(bytes) {
  return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

/**
 * Extract the largest embedded MP4 from a scene.pkg buffer (video textures
 * ranked by texture path score, mirroring the reference extractor), or the
 * largest embedded JPEG (photographic scenes), or null.
 * Accepts Buffer or Uint8Array (the Reader needs Buffer methods — views
 * from fs.promises.readFile().buffer or similar are coerced here).
 */
function extractSceneMedia(pkgData) {
  if (pkgData && !Buffer.isBuffer(pkgData) && pkgData.buffer instanceof ArrayBuffer) {
    pkgData = Buffer.from(pkgData.buffer, pkgData.byteOffset, pkgData.byteLength)
  }
  const entries = parsePkg(pkgData)
  const videos = []
  const jpegs = []
  for (const entry of entries) {
    const lower = entry.path.toLowerCase()
    if (!lower.endsWith('.tex')) continue
    let bytes
    try { bytes = readPkgEntry(pkgData, entry) } catch { continue }
    const mp4 = texMip0IsMp4(bytes)
    if (mp4) {
      let score = 1000
      if (/mask|normal|lightmap/i.test(entry.path)) score -= 800
      if (/background|main/i.test(entry.path)) score += 50
      videos.push({ path: entry.path, score, bytes: Buffer.from(mp4) })
      continue
    }
    if (isJpegPayload(bytes)) {
      jpegs.push({ path: entry.path, size: bytes.length, bytes: Buffer.from(bytes) })
    }
  }
  if (videos.length) {
    videos.sort((a, b) => b.score - a.score || b.bytes.length - a.bytes.length)
    return { kind: 'video', bytes: videos[0].bytes, path: videos[0].path }
  }
  if (jpegs.length) {
    jpegs.sort((a, b) => b.size - a.size)
    return { kind: 'image', bytes: jpegs[0].bytes, path: jpegs[0].path }
  }
  return null
}

/** Loose-scene variant: scan a directory's .tex files directly. */
async function extractSceneMediaFromDir(dir) {
  const fs = require('node:fs')
  const pathMod = require('node:path')
  const videos = []
  const jpegs = []
  const walk = async (sub, depth) => {
    if (depth > 4) return
    let names = []
    try { names = await fs.promises.readdir(sub === '' ? dir : pathMod.join(dir, sub)) } catch { return }
    for (const name of names) {
      const rel = sub === '' ? name : `${sub}/${name}`
      const abs = pathMod.join(dir, rel)
      let stat
      try { stat = await fs.promises.lstat(abs) } catch { continue }
      if (stat.isDirectory()) await walk(rel, depth + 1)
      else if (name.toLowerCase().endsWith('.tex')) {
        let bytes
        try { bytes = await fs.promises.readFile(abs) } catch { continue }
        const mp4 = texMip0IsMp4(bytes)
        if (mp4) {
          let score = 1000
          if (/mask|normal|lightmap/i.test(rel)) score -= 800
          if (/background|main/i.test(rel)) score += 50
          videos.push({ path: rel, score, bytes: Buffer.from(mp4) })
        } else if (isJpegPayload(bytes)) {
          jpegs.push({ path: rel, size: bytes.length, bytes: Buffer.from(bytes) })
        }
      }
    }
  }
  await walk('', 0)
  if (videos.length) {
    videos.sort((a, b) => b.score - a.score || b.bytes.length - a.bytes.length)
    return { kind: 'video', bytes: videos[0].bytes, path: videos[0].path }
  }
  if (jpegs.length) {
    jpegs.sort((a, b) => b.size - a.size)
    return { kind: 'image', bytes: jpegs[0].bytes, path: jpegs[0].path }
  }
  return null
}

module.exports = { extractSceneMedia, extractSceneMediaFromDir, lz4DecompressBlock, parsePkg, readPkgEntry }
