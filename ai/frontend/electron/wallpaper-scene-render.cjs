/**
 * Wallpaper Engine scene → offline render bridge (Electron main process).
 *
 * Wraps the vendored dsh-wallpaper-engine scene rendering stack
 * (vendor/we-scene/, MIT — elysia395) in a worker thread so slow CPU
 * rasterization never blocks the main process. Two modes, mirroring the
 * reference's proven pipeline:
 *   - single frame  → PNG bytes (static-frame upgrade for preview.jpg)
 *   - frame series  → APNG → ffmpeg → MP4 (hardware-decoded loop video)
 *
 * The animation sampling rules are carried over from the reference's
 * scene-anim route because they fix real bugs it already hit:
 *   - sample window covers camera-path period + property-animation length +
 *     particle starttime (otherwise animations get truncated / sped up)
 *   - scene ortho aspect correction (viewport ratio ≠ scene ratio crops)
 *   - video textures frozen at their first frame (per-frame ffmpeg extraction
 *     is too costly offline; embedded-MP4 scenes skip this path entirely)
 *
 * Failure contract: every entry point resolves {ok:false, ...} instead of
 * throwing — callers fall back to preview images and life goes on.
 */

const path = require('node:path')
const fs = require('node:fs')
const { Worker } = require('node:worker_threads')
const { createHash } = require('node:crypto')

const VENDOR_DIR = path.join(__dirname, 'vendor', 'we-scene')
const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

/** Wallpaper Engine install dir (holds assets/ used by official effects). */
let weAssetsDirCache = undefined
async function resolveWeAssetsDir() {
  if (weAssetsDirCache !== undefined) return weAssetsDirCache
  weAssetsDirCache = null
  const candidates = []
  if (process.env.AURORA_WE_INSTALL_DIR && process.env.AURORA_WE_INSTALL_DIR.trim()) {
    candidates.push(process.env.AURORA_WE_INSTALL_DIR.trim())
  }
  // Same Steam discovery as wallpaper-library.cjs (async — resolve lazily).
  try {
    const { locateWallpaperEngine } = require('./wallpaper-library.cjs')
    const install = locateWallpaperEngine ? await locateWallpaperEngine() : null
    if (install && fs.existsSync(install)) candidates.push(install)
  } catch { /* library module unavailable — env/defaults only */ }
  candidates.push('D:\\steam\\steamapps\\common\\wallpaper_engine')
  candidates.push('C:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine')
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'assets')) || fs.existsSync(path.join(c, 'bin'))) {
        weAssetsDirCache = c
        return weAssetsDirCache
      }
    } catch { /* keep looking */ }
  }
  return weAssetsDirCache
}

// ── Quality gate ────────────────────────────────────────────────────────────
// The reference renderer handles most scenes but draws some with their content
// confined to a corner (unported effect/layout math) — an eyeball-passed
// "half black" frame. The worker samples coverage (non-black pixel ratio) on
// every render; below 50% the frame is rejected here and the caller falls
// back to the preview image. Failure marker files stop repeat attempts.

const FRAME_MIN_COVERAGE = 0.5

// ── Worker invocation ───────────────────────────────────────────────────────

/** One render at a time; wallpaper frame rendering is strictly background. */
let activeWorker = null
const workerQueue = []

function runWorker(payload) {
  return new Promise(async resolve => {
    // weAssetsDir needs async Steam discovery — resolve before the sync job start.
    const weAssetsDir = (await resolveWeAssetsDir()) || undefined
    const job = { payload: { ...payload, weAssetsDir }, resolve }
    if (activeWorker) workerQueue.push(job)
    else startJob(job)
  })
}

function startJob(job) {
  activeWorker = job
  let worker
  let settled = false
  const finish = value => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    try { worker?.terminate() } catch { /* already dead */ }
    activeWorker = null
    const next = workerQueue.shift()
    if (next) startJob(next)
    job.resolve(value)
  }
  const framesN = job.payload.times?.length || 1
  // Generous timeout mirroring the reference (large scenes rasterize slowly).
  const timer = setTimeout(() => finish({ ok: false, error: 'scene render timeout' }), 600_000 * framesN)
  try {
    worker = new Worker(path.join(VENDOR_DIR, 'scene-render-worker.mjs'), {
      workerData: {
        src: job.payload.src,
        width: job.payload.width,
        height: job.payload.height,
        time: job.payload.time ?? 0,
        times: job.payload.times ?? null,
        frameDelayMs: job.payload.frameDelayMs ?? 100,
        weAssetsDir: job.payload.weAssetsDir,
        videoFrames: job.payload.videoFrames ?? null,
      },
      type: 'module',
    })
  } catch (error) {
    finish({ ok: false, error: String(error?.message || error) })
    return
  }
  worker.on('message', msg => {
    if (msg?.progress) {
      // Progress ticks carry no payload — consume them even when nobody
      // listens, or they fall through to the failure branch below.
      if (job.onProgress) {
        try { job.onProgress(msg.done || 0, msg.total || framesN) } catch { /* ui only */ }
      }
      return
    }
    if (msg?.ok) {
      // Quality gate: content confined to a corner (coverage < 50%) means the
      // renderer failed on this scene's layout — reject before it ever lands
      // in the cache or on screen.
      if (typeof msg.coverage === 'number' && msg.coverage < FRAME_MIN_COVERAGE) {
        finish({ ok: false, error: `low-coverage render (${Math.round(msg.coverage * 100)}%)`, lowCoverage: true })
        return
      }
      finish({ ok: true, png: msg.png ? Buffer.from(msg.png) : null, apng: msg.apng ? Buffer.from(msg.apng) : null })
    } else {
      finish({ ok: false, error: (msg && msg.error) || 'scene render failed' })
    }
  })
  worker.once('error', e => finish({ ok: false, error: String(e?.message || e) }))
  worker.once('exit', code => { if (code !== 0) finish({ ok: false, error: 'scene render worker exited ' + code }) })
}

// ── Scene aspect + animation sampling (ported from the reference route) ────

const aspectCache = new Map()

/** Scene ortho width/height ratio — rendering at the viewport ratio crops
 *  scenes whose projection differs (the reference's documented pitfall). */
async function sceneAspect(srcPath) {
  if (aspectCache.has(srcPath)) return aspectCache.get(srcPath)
  let ar = null
  try {
    const { readPkg } = await import('file://' + path.join(VENDOR_DIR, 'we-renderer', 'textures.js').replace(/\\/g, '/'))
    const src = String(srcPath).toLowerCase().endsWith('.json') ? path.dirname(srcPath) : srcPath
    const pk = readPkg(src)
    const sc = pk.readJson('scene.json')
    const ortho = sc && sc.general && sc.general.orthogonalprojection
    if (ortho && ortho.width && ortho.height) ar = parseFloat(ortho.width) / parseFloat(ortho.height)
  } catch { /* keep null */ }
  aspectCache.set(srcPath, ar)
  return ar
}

/** Total animation loop: camera paths + property animations + particle
 *  starttime. Rendering less than this truncates or speeds up the animation
 *  — the reference calls this "the main cause of universally wrong motion". */
async function sceneLoopPeriod(srcPath) {
  let period = 0, starttime = 0, animDuration = 0
  try {
    const { SceneRenderer } = await import('file://' + path.join(VENDOR_DIR, 'scene-renderer.js').replace(/\\/g, '/'))
    const src = String(srcPath).toLowerCase().endsWith('.json') ? path.dirname(srcPath) : srcPath
    const r = new SceneRenderer(src, { width: 320, height: 180, time: 0, weAssetsDir: (await resolveWeAssetsDir()) || undefined, log: () => {} })
    const cam = r.scene.camera || {}
    const paths = Array.isArray(cam.paths) ? cam.paths : []
    for (const p of paths) {
      if (typeof p === 'string') {
        try { const j = r.pkg.readJson(p); if (j && Array.isArray(j.paths)) for (const pp of j.paths) period += (pp.duration || 0) } catch { /* skip */ }
      } else if (p && Array.isArray(p.transforms)) {
        period += (p.duration || 0)
      }
    }
    const ANIM_KEYS = ['alpha', 'scale', 'origin', 'angles', 'visible', 'color', 'size', 'brightness', 'parallaxDepth', 'zoom']
    for (const o of r.objects || []) {
      if (o.particle && typeof o.particle === 'string') {
        try { const pd = r.pkg.readJson(o.particle); if (pd && pd.starttime) starttime = Math.max(starttime, pd.starttime) } catch { /* skip */ }
      }
      for (const key of ANIM_KEYS) {
        const v = o[key]
        if (!v || typeof v !== 'object' || !v.animation || !v.animation.options) continue
        const len = v.animation.options.length || 0
        const afps = v.animation.options.fps || 30
        if (len > 0) animDuration = Math.max(animDuration, len / afps)
      }
    }
  } catch { /* keep partial zeros */ }
  return Math.max(period, animDuration, starttime, 2)
}

// ── Cache layout (data/cache/wallpaper-scenes, same dir as extracted media) ─

function cachePaths(entryPath, tag, ext) {
  let mtime = 0
  try { mtime = Math.round(fs.statSync(entryPath).mtimeMs) } catch { /* keep 0 */ }
  const key = 'sr1_' + createHash('sha256')
    .update(`${entryPath}|${mtime}|${tag}`)
    .digest('hex').slice(0, 20)
  const dir = path.join(PROJECT_ROOT, 'data', 'cache', 'wallpaper-scenes')
  fs.mkdirSync(dir, { recursive: true })
  return { file: path.join(dir, key + ext), dir }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Pure cache check (no rendering): does a rendered frame / animation MP4
 * already exist for this scene? Lets the pick chain serve cached upgrades
 * without ever touching the worker queue.
 */
function peekSceneFrame(entryPath, { width = 1280, height = 720 } = {}) {
  const src = String(entryPath).toLowerCase().endsWith('.json') ? path.dirname(entryPath) : entryPath
  let h = height
  // Aspect correction needs the scene's ortho ratio; a cheap cached lookup.
  return sceneAspect(src).then(sar => {
    if (sar) h = Math.round(width / sar)
    const file = cachePaths(src, `frame_${width}x${h}`, '.png').file
    return fs.existsSync(file) ? file : null
  })
}

function peekSceneAnimation(entryPath, { fps = 12, width = 1280, height = 720 } = {}) {
  const src = String(entryPath).toLowerCase().endsWith('.json') ? path.dirname(entryPath) : entryPath
  return sceneAspect(src).then(sar => {
    let h = height
    if (sar) h = Math.round(width / sar)
    const file = cachePaths(src, `anim_${width}x${h}_${fps}fps`, '.mp4').file
    return fs.existsSync(file) ? file : null
  })
}

/**
 * Render one high-quality static frame (PNG) for a scene.
 * Returns { ok, path } or { ok:false, reason }.
 */
async function renderSceneFrame(entryPath, { width = 3840, height = 2160 } = {}) {
  const src = String(entryPath).toLowerCase().endsWith('.json') ? path.dirname(entryPath) : entryPath
  let w = width, h = height
  const sar = await sceneAspect(src)
  if (sar) h = Math.round(w / sar)
  const out = cachePaths(src, `frame_${w}x${h}`, '.png')
  if (fs.existsSync(out.file)) return { ok: true, path: out.file }
  // Reference's tuned constants: render at 3840-wide (effect shaders compute
  // against the render resolution — undersized canvases misplace water/particle
  // layers) and sample t=2.5s (post-intro steady state in every scene it
  // verified). time 0 drew mid fly-in frames (mostly black).
  const time = 2.5
  const result = await runWorker({ src, width: w, height: h, time })
  if (!result.ok || !result.png) return { ok: false, reason: result.error || 'empty frame' }
  const tmp = `${out.file}.tmp${process.pid}`
  try {
    fs.writeFileSync(tmp, result.png)
    fs.renameSync(tmp, out.file)
    return { ok: true, path: out.file }
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) }
  }
}

/**
 * Render the scene's full animation loop as an MP4 (APNG intermediate).
 * fps/sec cap the job; the loop length comes from the scene itself, so slow
 * scenes yield longer videos rather than sped-up ones (reference's fix).
 * Returns { ok, path, frames } or { ok:false, reason }.
 */
async function renderSceneAnimation(entryPath, {
  fps = 12,
  maxSec = 20,
  width = 2560,
  height = 1440,
  ffmpeg = null,
  onProgress = null,
} = {}) {
  const src = entryPath.toLowerCase().endsWith('.json') ? path.dirname(entryPath) : entryPath
  let w = width, h = height
  const sar = await sceneAspect(src)
  if (sar) h = Math.round(w / sar)
  const loop = Math.min(await sceneLoopPeriod(src), maxSec)
  // Skip the intro segment: most scenes open with a camera fly-in / fade-in,
  // so frames near t=0 are not the steady-state look — a looping video that
  // includes them visibly "flashes" every cycle (verified: frame 0 of the
  // Kaiserin scene was mostly black). Sampling [skip, skip+loop) keeps the
  // window closed (last frame == first frame) for a seamless loop. The 2.5s
  // floor matches the reference's tuned steady-state constant.
  const skip = Math.max(2.5, Math.min(2, loop / 4))
  const frameCount = Math.max(2, Math.round(fps * loop))
  const times = []
  for (let i = 0; i < frameCount; i++) times.push(skip + (i / frameCount) * loop)

  const out = cachePaths(src, `anim_${w}x${h}_${fps}fps`, '.mp4')
  const inflightKey = out.file
  if (fs.existsSync(out.file)) return { ok: true, path: out.file, frames: frameCount }
  if (animInflight.has(inflightKey)) return animInflight.get(inflightKey)

  const job = (async () => {
    const result = await runWorker({
      src, width: w, height: h, time: times[0], times,
      frameDelayMs: Math.round(1000 / fps),
    }, )
    if (!result.ok || !result.apng) return { ok: false, reason: result.error || 'empty apng' }
    if (!ffmpeg) return { ok: false, reason: 'ffmpeg-unavailable' }
    // APNG → MP4 (hardware-decodable, loops seamlessly via our video layer).
    // Encoder fallback chain mirrors wallpaper-transcode.cjs: bundled ffmpeg
    // builds are often trimmed (no libx264), so hardware encoders cover it —
    // nvenc keeps CPU free for Live2D, mf (MediaFoundation) is the OS fallback.
    // -r on BOTH sides: the APNG delay metadata makes ffmpeg infer a 100000fps
    // stream and encoders refuse to initialize ("incorrect parameters").
    // tmp names MUST keep their media extensions — ffmpeg picks the muxer
    // from the trailing extension and "out.mp4.tmp123" fails with EINVAL.
    const tmpApng = `${out.file.slice(0, -4)}.tmp${process.pid}.apng`
    const tmpOut = `${out.file.slice(0, -4)}.tmp${process.pid}.mp4`
    try {
      fs.writeFileSync(tmpApng, result.apng)
      const encoders = ['libx264', 'h264_nvenc', 'h264_mf']
      let lastError = null
      let encoded = false
      for (const encoder of encoders) {
        try {
          await new Promise((resolve, reject) => {
            const { execFile } = require('node:child_process')
            execFile(ffmpeg, [
              '-y', '-hide_banner', '-loglevel', 'error',
              '-r', String(fps), '-i', tmpApng,
              '-c:v', encoder, '-pix_fmt', 'yuv420p',
              '-r', String(fps), '-movflags', '+faststart', tmpOut,
            ], { windowsHide: true, timeout: 10 * 60_000 }, (err) => err ? reject(err) : resolve())
          })
          encoded = true
          break
        } catch (error) {
          lastError = error
          try { fs.unlinkSync(tmpOut) } catch { /* ignore */ }
        }
      }
      if (!encoded) throw lastError || new Error('no h264 encoder available')
      fs.renameSync(tmpOut, out.file)
      return { ok: true, path: out.file, frames: frameCount }
    } catch (error) {
      try { fs.unlinkSync(tmpOut) } catch { /* ignore */ }
      return { ok: false, reason: String(error?.message || error) }
    } finally {
      try { fs.unlinkSync(tmpApng) } catch { /* ignore */ }
    }
  })()
  animInflight.set(inflightKey, job)
  try {
    return await job
  } finally {
    animInflight.delete(inflightKey)
  }
}

const animInflight = new Map()

/** Shared inflight guard for the frame path too (pick storms). */
const frameInflight = new Map()
function renderSceneFrameOnce(entryPath, opts) {
  const key = entryPath + '|' + (opts?.width || 1280)
  if (frameInflight.has(key)) return frameInflight.get(key)
  const p = renderSceneFrame(entryPath, opts).finally(() => frameInflight.delete(key))
  frameInflight.set(key, p)
  return p
}

module.exports = {
  renderSceneFrame: renderSceneFrameOnce,
  renderSceneAnimation,
  resolveWeAssetsDir,
  peekSceneFrame,
  peekSceneAnimation,
}
