/**
 * Wallpaper video fps-cap transcode (Electron main process).
 *
 * Implements the frame-skip strategy proven in dsh-wallpaper-engine (MIT —
 * github.com/elysia395/dsh-wallpaper-engine): the fps cap is a ONE-TIME
 * re-encode to the capped frame rate (timeline stays 1.0x; decode load drops
 * linearly with fps), cached by path+mtime+fps, served with Range support.
 * The client plays the original immediately and swaps when the transcode
 * lands; any failure silently falls back to the original.
 *
 * MP4 metadata (fps/width/height/duration) is probed with a minimal moov-box
 * walker — no ffprobe process needed for the skip decision.
 *
 * ffmpeg resolution chain:
 *   AURORA_WALLPAPER_FFMPEG env → GPT-SoVITS runtime ffmpeg → system PATH.
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFile, spawn } = require('node:child_process')
const { createHash } = require('node:crypto')

// ── MP4 moov probe (ported minimal box walker) ─────────────────────────────

const VIDEO_CODECS = new Set(['avc1', 'hvc1', 'hev1', 'av01', 'vp09', 'mp4v'])

function readBoxes(buf, start, end, onBox) {
  let off = start
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    let header = 8
    if (size === 1) {
      if (off + 16 > end) break
      size = Number(buf.readBigUInt64BE(off + 8))
      header = 16
    } else if (size === 0) {
      size = end - off
    }
    if (size < header || off + size > end) break
    if (onBox(type, off, size, header)) return
    off += size
  }
}

function boxChild(buf, container, type) {
  let found = null
  readBoxes(buf, container.off + container.header, container.off + container.size,
    (t, o, s, h) => { if (t === type) { found = { off: o, size: s, header: h }; return true } return false })
  return found
}

function probeMp4(abs) {
  const fd = fs.openSync(abs, 'r')
  try {
    const fileSize = fs.fstatSync(fd).size
    if (fileSize < 64) return null
    const headLen = Math.min(fileSize, 8 * 1024 * 1024)
    const tailLen = Math.min(fileSize, 8 * 1024 * 1024)
    const head = Buffer.alloc(headLen)
    const tail = Buffer.alloc(tailLen)
    fs.readSync(fd, head, 0, headLen, 0)
    fs.readSync(fd, tail, 0, tailLen, fileSize - tailLen)
    // moov near the head (faststart) or anchored to EOF (normal).
    const findMoov = (buf, bufStart, anchoredToEof, limit) => {
      const scanEnd = Math.min(buf.length - 4, limit || buf.length)
      for (let i = scanEnd; i >= 4; i--) {
        if (buf[i] === 0x6d && buf[i + 1] === 0x6f && buf[i + 2] === 0x6f && buf[i + 3] === 0x76) {
          const s = buf.readUInt32BE(i - 4)
          const start = bufStart + i - 4
          if (s >= 8 && start >= 0 && start + s <= fileSize + 8) {
            if (!anchoredToEof || (start + s >= fileSize - 128)) return { start, size: s }
          }
        }
      }
      return null
    }
    const moov = findMoov(head, 0, false, 1024 * 1024) || findMoov(tail, fileSize - tailLen, true, tailLen)
    if (!moov) return null
    const moovBuf = Buffer.alloc(moov.size)
    fs.readSync(fd, moovBuf, 0, moov.size, moov.start)
    const moovEnd = moov.size
    const traks = []
    readBoxes(moovBuf, 8, moovEnd, (t, o, s, h) => { if (t === 'trak') { traks.push({ off: o, size: s, header: h }) ; } return false })
    let best = null
    for (const trak of traks) {
      const mdia = boxChild(moovBuf, trak, 'mdia')
      if (!mdia) continue
      const hdlr = boxChild(moovBuf, mdia, 'hdlr')
      if (hdlr && moovBuf.toString('latin1', hdlr.off + hdlr.header + 8, hdlr.off + hdlr.header + 12) !== 'vide') continue
      const mdhd = boxChild(moovBuf, mdia, 'mdhd')
      const minf = boxChild(moovBuf, mdia, 'minf')
      const stbl = minf ? boxChild(moovBuf, minf, 'stbl') : null
      const stsd = stbl ? boxChild(moovBuf, stbl, 'stsd') : null
      const stts = stbl ? boxChild(moovBuf, stbl, 'stts') : null
      const info = { width: 0, height: 0, codec: null, fps: null }
      if (stsd) {
        const entryStart = stsd.off + stsd.header + 8
        if (entryStart + 52 <= moovEnd) {
          const codec = moovBuf.toString('latin1', entryStart + 4, entryStart + 8)
          if (VIDEO_CODECS.has(codec)) {
            info.codec = codec
            info.width = moovBuf.readUInt16BE(entryStart + 32)
            info.height = moovBuf.readUInt16BE(entryStart + 34)
          }
        }
      }
      if (mdhd && info.codec) {
        const ver = moovBuf.readUInt8(mdhd.off + mdhd.header)
        const timescale = ver === 1
          ? Number(moovBuf.readBigUInt64BE(mdhd.off + mdhd.header + 20))
          : moovBuf.readUInt32BE(mdhd.off + mdhd.header + 12)
        const duration = ver === 1
          ? Number(moovBuf.readBigUInt64BE(mdhd.off + mdhd.header + 28))
          : moovBuf.readUInt32BE(mdhd.off + mdhd.header + 16)
        if (timescale > 0 && duration > 0) {
          info.duration = Math.round((duration / timescale) * 100) / 100
          if (stts) {
            const entryCount = moovBuf.readUInt32BE(stts.off + stts.header + 4)
            let samples = 0
            let ticks = 0
            for (let i = 0; i < entryCount; i++) {
              const e = stts.off + stts.header + 8 + i * 8
              if (e + 8 > moovEnd) break
              const cnt = moovBuf.readUInt32BE(e)
              const delta = moovBuf.readUInt32BE(e + 4)
              samples += cnt
              ticks += cnt * delta
            }
            if (ticks > 0) info.fps = Math.round((samples * timescale / ticks) * 100) / 100
          }
        }
      }
      if (info.codec) { best = info; break }
    }
    return best && (best.fps || best.width) ? best : null
  } finally {
    fs.closeSync(fd)
  }
}

const mediaInfoCache = new Map()

function getMediaInfo(abs) {
  if (!abs || !fs.existsSync(abs)) return null
  const st = fs.statSync(abs)
  const key = `${abs}|${st.size}|${Math.round(st.mtimeMs)}`
  if (mediaInfoCache.has(key)) return mediaInfoCache.get(key)
  let info = null
  try { info = probeMp4(abs) } catch { info = null }
  if (mediaInfoCache.size > 500) {
    const first = mediaInfoCache.keys().next().value
    if (first !== undefined) mediaInfoCache.delete(first)
  }
  mediaInfoCache.set(key, info)
  return info
}

// ── ffmpeg resolution ───────────────────────────────────────────────────────

/** Project root (three levels up from this file: frontend/electron → ai). */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

function candidateFfmpegPaths() {
  const candidates = []
  if (process.env.AURORA_WALLPAPER_FFMPEG && process.env.AURORA_WALLPAPER_FFMPEG.trim()) {
    candidates.push(process.env.AURORA_WALLPAPER_FFMPEG.trim())
  }
  // GPT-SoVITS runtime ships a full ffmpeg build with the models directory.
  try {
    const modelsDir = path.join(PROJECT_ROOT, 'models', 'tts')
    if (fs.existsSync(modelsDir)) {
      for (const name of fs.readdirSync(modelsDir)) {
        const exe = path.join(modelsDir, name, 'runtime', 'ffmpeg.exe')
        if (fs.existsSync(exe)) candidates.push(exe)
      }
    }
  } catch { /* models dir missing — fine */ }
  return candidates
}

let resolvedFfmpeg = null
let ffmpegResolved = false

function resolveFfmpeg() {
  if (ffmpegResolved) return resolvedFfmpeg
  ffmpegResolved = true
  for (const candidate of candidateFfmpegPaths()) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      resolvedFfmpeg = candidate
      return resolvedFfmpeg
    } catch { /* keep looking */ }
  }
  resolvedFfmpeg = 'ffmpeg' // system PATH (last resort)
  return resolvedFfmpeg
}

/** Synchronous capability probe: does the resolved ffmpeg actually run? */
let ffmpegUsable = null
function ffmpegAvailable() {
  if (ffmpegUsable !== null) return Promise.resolve(ffmpegUsable)
  const exe = resolveFfmpeg()
  return new Promise(resolve => {
    execFile(exe, ['-version'], { windowsHide: true, timeout: 8000 }, (err) => {
      ffmpegUsable = !err
      resolve(ffmpegUsable)
    })
  })
}

// ── Transcode jobs ──────────────────────────────────────────────────────────

const TRANSCODE_TIMEOUT_MS = Number(process.env.AURORA_WALLPAPER_TRANSCODE_TIMEOUT_MS) || 15 * 60 * 1000
const MAX_CONCURRENT = 1 // wallpaper transcodes are strictly background work
let activeCount = 0
const waiters = []

function acquireSlot() {
  if (activeCount < MAX_CONCURRENT) {
    activeCount += 1
    return Promise.resolve()
  }
  return new Promise(resolveSlot => waiters.push(resolveSlot))
}
function releaseSlot() {
  const next = waiters.shift()
  if (next) next()
  else activeCount -= 1
}

function transcodeCacheDir() {
  const dir = path.join(PROJECT_ROOT, 'data', 'cache', 'wallpaper-transcodes')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const inflight = new Map()
const jobProgress = new Map()

/**
 * Ensure a capped-fps transcode exists for `abs`. Returns the output path,
 * or null when transcode is impossible/failed (caller falls back to source).
 */
async function transcodeToFps(abs, fps) {
  if (!Number.isInteger(fps) || fps <= 0) return null
  const info = getMediaInfo(abs)
  if (!info || !info.fps || info.fps <= fps + 0.01) return null // at/below cap already
  if (!(await ffmpegAvailable())) return null

  const st = fs.statSync(abs)
  const key = createHash('sha256').update(`${abs}|${Math.round(st.mtimeMs)}|${fps}`).digest('hex').slice(0, 20)
  const out = path.join(transcodeCacheDir(), `tc_${key}.mp4`)
  if (fs.existsSync(out)) return out
  if (inflight.has(out)) return inflight.get(out)

  const job = (async () => {
    await acquireSlot()
    const deadline = Date.now() + TRANSCODE_TIMEOUT_MS
    try {
      const ff = resolveFfmpeg()
      // Bitrate scaled by resolution (size ∝ time → progress from file size).
      const pixels = info.width && info.height ? info.width * info.height : 3840 * 2160
      const bitrate = Math.round(Math.min(20e6, Math.max(4e6, 20e6 * pixels / (3840 * 2160))))
      const args = [
        '-y', '-hide_banner', '-loglevel', 'error', '-i', abs,
        '-map', '0:v:0', '-an', '-preset', 'veryfast',
        '-b:v', String(bitrate), '-maxrate', String(bitrate), '-bufsize', String(bitrate * 2),
        '-vf', `fps=${fps}`, '-g', String(fps * 2),
      ]
      if (info.duration && Number.isFinite(info.duration) && info.duration > 0) {
        args.push('-t', String(info.duration))
      }
      // H.264 baseline first (universally decodable); AV1 offers better NVDEC
      // throughput but only when the encoder exists — try it second.
      const tmp = `${out}.tmp${process.pid}`
      for (const encoder of ['libx264', 'av1_nvenc', 'h264_nvenc']) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        try {
          await runFfmpeg(ff, [...args, '-c:v', encoder, '-f', 'mp4', tmp], remaining, out, info)
          fs.renameSync(tmp, out)
          return out
        } catch (error) {
          try { fs.unlinkSync(tmp) } catch { /* ignore */ }
          if (Date.now() >= deadline) break
        }
      }
      return null
    } finally {
      releaseSlot()
      inflight.delete(out)
    }
  })()

  inflight.set(out, job)
  return job
}

function runFfmpeg(ff, args, timeoutMs, finalOutPath, info) {
  return new Promise((resolve, reject) => {
    const child = spawn(ff, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] })
    const tmpPath = args[args.length - 1]
    jobProgress.set(finalOutPath, { phase: 'transcode', percent: 0, etaSeconds: null })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      reject(new Error('transcode timeout'))
    }, timeoutMs)
    const expectedBytes = info.duration ? Math.round((12e6 / 8) * info.duration) : null
    const tick = setInterval(() => {
      if (!expectedBytes) return
      try {
        const size = fs.statSync(tmpPath).size
        jobProgress.set(finalOutPath, {
          phase: 'transcode',
          percent: Math.min(99, Math.round(size / expectedBytes * 100)),
          etaSeconds: null,
        })
      } catch { /* tmp not created yet */ }
    }, 1000)
    child.on('error', err => {
      clearTimeout(timer); clearInterval(tick)
      jobProgress.delete(finalOutPath)
      reject(err)
    })
    child.on('exit', code => {
      clearTimeout(timer); clearInterval(tick)
      jobProgress.delete(finalOutPath)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exit ${code}`))
    })
  })
}

function transcodeProgress(abs, fps) {
  const st = fs.statSync(abs)
  const key = createHash('sha256').update(`${abs}|${Math.round(st.mtimeMs)}|${fps}`).digest('hex').slice(0, 20)
  const out = path.join(transcodeCacheDir(), `tc_${key}.mp4`)
  return jobProgress.get(out) || (fs.existsSync(out) ? { phase: 'done', percent: 100 } : null)
}

module.exports = {
  getMediaInfo,
  probeMp4,
  transcodeProgress,
  transcodeToFps,
}
