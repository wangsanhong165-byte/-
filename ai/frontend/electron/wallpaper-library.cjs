/**
 * Wallpaper Engine library discovery + enumeration (Electron main process).
 *
 * Steam discovery chain (ported from dsh-wallpaper-engine, MIT —
 * github.com/elysia395/dsh-wallpaper-engine, lib/index.js):
 *   1. AURORA_STEAM_ROOT / STEAM_PATH / STEAM_INSTALL_PATH env overrides
 *   2. HKCU\Software\Valve\Steam via reg.exe (language-independent key)
 *   3. Conventional install locations
 *   4. libraryfolders.vdf parsing — every library OWNING app 431960, plus the
 *      root the vdf itself lives in (the default library never appears as a
 *      "path" entry — missing that check drops every workshop wallpaper).
 *
 * Enumeration: wallpaper_engine/projects/{defaultprojects,myprojects} plus
 * steamapps/workshop/content/431960/*, each project.json → {id,title,type,
 * entryFile,previewFile}. Scene projects resolve their real main container
 * (declared file → scene.pkg → scene.json → sole *.pkg).
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

const WE_APPID = '431960'
const PROBE_TTL_MS = 60 * 1000

const STEAM_PROBE_DIRS = [
  'C:\\Program Files (x86)\\Steam',
  'C:\\Program Files\\Steam',
  'D:\\Steam',
  'D:\\SteamLibrary',
  'E:\\SteamLibrary',
]

// ── async helpers (fs.promises keeps the scan off the event loop) ──────────

async function pathExists(p) {
  try { await fs.promises.access(p); return true } catch { return false }
}
async function isDirectory(p) {
  try { return (await fs.promises.stat(p)).isDirectory() } catch { return false }
}
async function isFile(p) {
  try { return (await fs.promises.stat(p)).isFile() } catch { return false }
}

// ── Steam discovery ─────────────────────────────────────────────────────────

function steamRootsFromEnv() {
  const raw = [
    process.env.AURORA_STEAM_ROOT,
    process.env.STEAM_PATH,
    process.env.STEAM_INSTALL_PATH,
  ].filter(v => v && v.trim())
  return raw.map(v => v.trim())
}

function steamPathFromRegistry() {
  return new Promise(resolve => {
    const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
    execFile(
      reg,
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) { resolve(null); return }
        const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(stdout || '')
        resolve(m ? m[1].trim() : null)
      },
    )
  })
}

/** Valve KeyValues-lite: every "path" entry of a libraryfolders.vdf. */
async function librariesFromVdf(vdfPath) {
  let text
  try { text = await fs.promises.readFile(vdfPath, 'utf8') } catch { return [] }
  const libs = []
  for (const match of text.matchAll(/"path"\s+"([^"]+)"/gi)) {
    const lib = match[1].replace(/\\\\/g, '\\')
    if (lib && !libs.includes(lib)) libs.push(lib)
  }
  return libs
}

let probeCache = null
let probeInflight = null

async function steamProbeDirs() {
  if (probeCache && Date.now() - probeCache.t < PROBE_TTL_MS) return probeCache.dirs
  if (probeInflight) return probeInflight
  probeInflight = (async () => {
    const registry = await steamPathFromRegistry()
    const env = steamRootsFromEnv()
    return [...(registry ? [registry] : []), ...env, ...STEAM_PROBE_DIRS]
  })()
  try {
    const dirs = await probeInflight
    probeCache = { t: Date.now(), dirs }
    return dirs
  } finally {
    probeInflight = null
  }
}

/** Directory holding wallpaper32.exe (the WE install proper). */
async function locateWallpaperEngine() {
  const candidates = []
  const libraries = []
  for (const probe of await steamProbeDirs()) {
    const vdf = path.join(probe, 'steamapps', 'libraryfolders.vdf')
    if (await pathExists(vdf)) {
      libraries.push(...await librariesFromVdf(vdf))
    }
  }
  const roots = [...(await steamProbeDirs()), ...libraries]
  for (const root of roots) candidates.push(path.join(root, 'steamapps', 'common', 'wallpaper_engine'))
  candidates.push('C:\\Program Files (x86)\\Wallpaper Engine')

  const seen = new Set()
  for (const raw of candidates) {
    const dir = path.normalize(raw)
    if (seen.has(dir)) continue
    seen.add(dir)
    if (await isFile(path.join(dir, 'wallpaper32.exe'))) return dir
  }
  return null
}

/** Libraries owning WE (for the workshop content root). */
async function owningLibraries() {
  const libs = []
  for (const probe of await steamProbeDirs()) {
    const vdf = path.join(probe, 'steamapps', 'libraryfolders.vdf')
    if (await pathExists(vdf)) {
      libs.push(...await librariesFromVdf(vdf))
    }
    // The Steam root a vdf lives in is itself a library but never appears as
    // a "path" entry — WE installed into the DEFAULT library drops every
    // workshop wallpaper without this.
    if (await isDirectory(path.join(probe, 'steamapps', 'common', 'wallpaper_engine'))) libs.push(probe)
  }
  return [...new Set(libs)]
}

// ── Project enumeration ─────────────────────────────────────────────────────

const VIDEO_RE = /\.(mp4|webm|mkv|avi|mov)$/i
const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp)$/i

function inferType(file) {
  if (VIDEO_RE.test(file)) return 'video'
  if (/\.html?$/i.test(file)) return 'web'
  return 'scene'
}

const KINDS = ['scene', 'video', 'web', 'application']

async function readProject(dir) {
  const projectPath = path.join(dir, 'project.json')
  if (!(await isFile(projectPath))) return null
  try {
    const parsed = JSON.parse(await fs.promises.readFile(projectPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !parsed.file) return null
    let type = typeof parsed.type === 'string' ? parsed.type.toLowerCase() : inferType(parsed.file)
    if (!KINDS.includes(type)) type = 'scene'
    return {
      id: path.basename(dir),
      title: typeof parsed.title === 'string' ? parsed.title : path.basename(dir),
      type,
      file: parsed.file,
      preview: typeof parsed.preview === 'string' ? parsed.preview : null,
    }
  } catch {
    return null
  }
}

/**
 * Scene projects: project.json declares scene.json while shipping only the
 * packed scene.pkg (workshop) or vice versa (loose). Probe declared →
 * scene.pkg → scene.json → a sole *.pkg in the directory.
 */
async function resolveSceneMainFile(dir, declared) {
  for (const candidate of [declared, 'scene.pkg', 'scene.json']) {
    if (!candidate) continue
    if (await isFile(path.resolve(dir, candidate))) return candidate
  }
  let pkgs = []
  try {
    pkgs = (await fs.promises.readdir(dir)).filter(name => name.toLowerCase().endsWith('.pkg'))
  } catch {
    return null
  }
  return pkgs.length === 1 ? pkgs[0] : null
}

const SCAN_CHUNK = 24

async function enumerateWallpapers(installDir, libraryDirs) {
  const found = new Map()
  const roots = []
  if (installDir) {
    for (const sub of ['defaultprojects', 'myprojects']) {
      const p = path.join(installDir, 'projects', sub)
      if (await pathExists(p)) roots.push(p)
    }
  }
  for (const lib of libraryDirs) {
    const ws = path.join(lib, 'steamapps', 'workshop', 'content', WE_APPID)
    if (await pathExists(ws)) roots.push(ws)
  }

  const projectDirs = []
  for (const root of roots) {
    let entries = []
    try { entries = await fs.promises.readdir(root) } catch { continue }
    for (const entry of entries) {
      const dir = path.join(root, entry)
      if (await isDirectory(dir)) projectDirs.push(dir)
    }
  }

  for (let i = 0; i < projectDirs.length; i += SCAN_CHUNK) {
    const chunk = projectDirs.slice(i, i + SCAN_CHUNK)
    const results = await Promise.all(
      chunk.map(dir => readProject(dir).then(project => project ? { dir, project } : null)),
    )
    for (const hit of results) {
      if (!hit || found.has(hit.project.id)) continue
      const { dir, project } = hit
      project.fileAbs = project.type === 'scene'
        ? path.resolve(dir, (await resolveSceneMainFile(dir, project.file)) || project.file)
        : path.resolve(dir, project.file)
      project.previewAbs = project.preview ? path.resolve(dir, project.preview) : null
      found.set(project.id, project)
    }
  }
  return [...found.values()].sort((a, b) => (a.title || '').localeCompare(b.title || ''))
}

// ── WE playlists (config.json, per-profile) ────────────────────────────────

function playlistRows(profile) {
  const general = profile && typeof profile === 'object' ? profile.general : null
  if (!general || typeof general !== 'object') return []
  if (Array.isArray(general.playlists) && general.playlists.length) return general.playlists
  const selected = general.wallpaperconfig && general.wallpaperconfig.selectedwallpapers
  if (!selected || typeof selected !== 'object') return []
  return Object.values(selected)
    .map(monitor => monitor && monitor.playlist)
    .filter(playlist => playlist && typeof playlist === 'object')
}

function pathKey(file) {
  return path.normalize(String(file).replace(/\//g, '\\')).toLowerCase()
}

function playlistId(profileName, index, name) {
  return Buffer.from(`${profileName}\0${index}\0${name}`, 'utf8').toString('base64url')
}

async function readPlaylists(installDir) {
  if (!installDir) return []
  const configPath = path.join(installDir, 'config.json')
  if (!(await pathExists(configPath))) return []
  let config
  try { config = JSON.parse(await fs.promises.readFile(configPath, 'utf8')) } catch { return [] }

  const result = []
  const seen = new Set()
  for (const [profileName, profile] of Object.entries(config || {})) {
    for (const [index, row] of playlistRows(profile).entries()) {
      const items = Array.isArray(row.items)
        ? row.items.filter(item => typeof item === 'string' && item.trim())
        : []
      if (!items.length) continue
      const name = typeof row.name === 'string' && row.name.trim()
        ? row.name.trim()
        : `Playlist ${index + 1}`
      const signature = `${name}\0${items.join('\0')}`
      if (seen.has(signature)) continue
      seen.add(signature)
      const settings = row.settings && typeof row.settings === 'object' ? row.settings : {}
      result.push({
        id: playlistId(profileName, index, name),
        name,
        items,
        order: settings.order === 'random' ? 'random' : 'sequence',
        delay: typeof settings.delay === 'number' ? settings.delay : null,
      })
    }
  }
  return result
}

/** Map a WE playlist item string onto an enumerated project id. */
function playlistItemId(item, byPath, byId) {
  const exact = byPath.get(pathKey(item))
  if (exact) return exact
  const match = /[\\/]431960[\\/]([^\\/]+)(?:[\\/]|$)/i.exec(item)
  const project = match ? byId.get(match[1]) : null
  if (project) return project.id
  const folder = /[\\/]([^\\/]+)[\\/][^\\/]+$/i.exec(item)
  if (folder && byId.has(folder[1])) return folder[1]
  return null
}

/**
 * Build the full inventory payload. Playable kinds: video/web (media entry
 * exists) and scene (resolved main file exists — its embedded video/preview
 * is extracted on demand). Application is never playable.
 */
async function buildInventory() {
  const installDir = await locateWallpaperEngine()
  const libraryDirs = await owningLibraries()
  const all = await enumerateWallpapers(installDir, libraryDirs)
  const byPath = new Map(all.map(w => [pathKey(w.fileAbs), w.id]))
  const byId = new Map(all.map(w => [w.id, w]))

  const wallpapers = []
  for (const w of all) {
    let playable = false
    if (w.type === 'video' || w.type === 'web') {
      playable = await isFile(w.fileAbs)
    } else if (w.type === 'scene') {
      playable = Boolean(w.fileAbs) && await isFile(w.fileAbs)
    }
    wallpapers.push({
      id: w.id,
      title: w.title,
      type: w.type,
      playable,
      entryPath: playable ? w.fileAbs : null,
      previewPath: w.previewAbs && await isFile(w.previewAbs) ? w.previewAbs : null,
    })
  }

  const playableIds = new Set(wallpapers.filter(w => w.playable).map(w => w.id))
  const playlists = (await readPlaylists(installDir)).map(playlist => {
    const ids = []
    const seenIds = new Set()
    for (const item of playlist.items) {
      const id = playlistItemId(item, byPath, byId)
      if (id && !seenIds.has(id)) { seenIds.add(id); ids.push(id) }
    }
    return {
      id: playlist.id,
      name: playlist.name,
      order: playlist.order,
      delay: playlist.delay,
      wallpaperIds: ids,
      total: ids.length,
      playableCount: ids.filter(id => playableIds.has(id)).length,
    }
  })

  return { installDir, total: wallpapers.length, playableCount: wallpapers.filter(w => w.playable).length, wallpapers, playlists }
}

module.exports = {
  buildInventory,
  librariesFromVdf,
  locateWallpaperEngine,
  owningLibraries,
  playlistItemId,
  playlistRows,
  readPlaylists,
  resolveSceneMainFile,
}
