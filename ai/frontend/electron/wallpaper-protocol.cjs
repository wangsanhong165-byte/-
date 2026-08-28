/**
 * wallpaper:// asset URL resolution (shared by main.cjs protocol handler).
 *
 * URL shapes (standard scheme → pathname keeps '/' segments):
 *   wallpaper://asset/<base64url-of-file>              → whitelisted file
 *   wallpaper://asset/<base64url-of-dir>/sub/file.js   → file inside a
 *     whitelisted web-project directory (traversal/symlink-guarded).
 *
 * The token is the longest base64url prefix of the first path segment
 * (base64url never contains '/'). Relative sub-resources the iframe resolves
 * against its own URL land in the trailing path segments.
 */

const path = require('node:path')
const fs = require('node:fs')

const WALLPAPER_MIME = {
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', mov: 'video/quicktime', m4v: 'video/mp4',
  html: 'text/html', htm: 'text/html', js: 'text/javascript',
  css: 'text/css', json: 'application/json',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
}

function wallpaperMime(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  return WALLPAPER_MIME[ext] || 'application/octet-stream'
}

function wallpaperResourceUrl(filePath) {
  const token = Buffer.from(path.resolve(filePath), 'utf8').toString('base64url')
  return `wallpaper://asset/${token}`
}

/** Web entry URL: token = project dir, entry appended as relative segment. */
function wallpaperProjectUrl(dirPath, entryFile) {
  const token = Buffer.from(path.resolve(dirPath), 'utf8').toString('base64url')
  const rel = path.relative(path.resolve(dirPath), path.resolve(entryFile)).replace(/\\/g, '/')
  return `wallpaper://asset/${token}/${rel}`
}

function decodeToken(token) {
  try {
    return Buffer.from(token, 'base64url').toString('utf8')
  } catch {
    return null
  }
}

/**
 * Resolve an asset URL against the whitelists.
 * @returns {{ filePath: string, dirScope: string|null } | null}
 */
function resolveWallpaperAsset(requestUrl, allowedFiles, allowedDirs) {
  let parsed
  try {
    parsed = new URL(requestUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'wallpaper:' || parsed.hostname !== 'asset') return null
  let pathname
  try {
    pathname = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
  } catch {
    return null
  }
  if (!pathname) return null
  const slash = pathname.indexOf('/')
  const tokenPart = slash === -1 ? pathname : pathname.slice(0, slash)
  const rest = slash === -1 ? '' : pathname.slice(slash + 1)
  if (!tokenPart) return null
  const base = decodeToken(tokenPart)
  if (!base) return null
  const normalizedBase = path.resolve(base)

  if (!rest) {
    if (allowedFiles.has(normalizedBase)) {
      return { filePath: normalizedBase, dirScope: null }
    }
    for (const dir of allowedDirs) {
      if (normalizedBase === dir || normalizedBase.startsWith(dir + path.sep)) {
        return { filePath: normalizedBase, dirScope: dir }
      }
    }
    return null
  }

  // Sub-resource inside a directory scope.
  const rel = rest.replace(/\\/g, '/')
  if (rel.split('/').includes('..')) return null
  const resolved = path.resolve(normalizedBase, rel)
  if (resolved !== normalizedBase && !resolved.startsWith(normalizedBase + path.sep)) return null
  if (!allowedDirs.has(normalizedBase)) return null
  // Symlink guard: the resolved real path must remain inside the scope.
  try {
    const real = fs.realpathSync(resolved)
    const realBase = fs.realpathSync(normalizedBase)
    if (real !== realBase && !real.startsWith(realBase + path.sep)) return null
  } catch {
    return null
  }
  return { filePath: resolved, dirScope: normalizedBase }
}

module.exports = {
  resolveWallpaperAsset,
  wallpaperMime,
  wallpaperProjectUrl,
  wallpaperResourceUrl,
}
