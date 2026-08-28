// Security-critical tests for wallpaper:// asset URL resolution:
// file whitelist, directory scopes, traversal/symlink/absolute-path guards.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const {
  resolveWallpaperAsset,
  wallpaperMime,
  wallpaperProjectUrl,
  wallpaperResourceUrl,
} = require('./wallpaper-protocol.cjs')

function makeScope() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-proto-'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>')
  fs.writeFileSync(path.join(dir, 'script.js'), 'x')
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.writeFileSync(path.join(dir, 'sub', 'deep.css'), 'body{}')
  return dir
}

test('whitelisted file resolves bare; unknown file rejected', () => {
  const scope = makeScope()
  const file = path.join(scope, 'script.js')
  const allowed = new Set([path.resolve(file)])
  const dirs = new Set()
  const ok = resolveWallpaperAsset(wallpaperResourceUrl(file), allowed, dirs)
  assert.equal(ok.filePath, path.resolve(file))
  assert.equal(ok.dirScope, null)
  const other = path.join(scope, 'index.html')
  assert.equal(resolveWallpaperAsset(wallpaperResourceUrl(other), allowed, dirs), null)
})

test('directory scope serves entry and nested sub-resources', () => {
  const scope = makeScope()
  const dirs = new Set([path.resolve(scope)])
  const allowed = new Set()

  const entryUrl = wallpaperProjectUrl(scope, path.join(scope, 'index.html'))
  const entry = resolveWallpaperAsset(entryUrl, allowed, dirs)
  assert.equal(entry.filePath, path.join(scope, 'index.html'))
  assert.equal(entry.dirScope, path.resolve(scope))

  // Relative sub-resource (what the iframe's <script src="sub/deep.css">
  // resolves to against the entry URL).
  const token = Buffer.from(path.resolve(scope), 'utf8').toString('base64url')
  const cssUrl = `wallpaper://asset/${token}/sub/deep.css`
  const css = resolveWallpaperAsset(cssUrl, allowed, dirs)
  assert.equal(css.filePath, path.join(scope, 'sub', 'deep.css'))
})

test('traversal attempts are rejected', () => {
  const scope = makeScope()
  const outside = path.join(path.dirname(scope), 'secret.txt')
  fs.writeFileSync(outside, 'secret')
  const dirs = new Set([path.resolve(scope)])
  const allowed = new Set()
  const token = Buffer.from(path.resolve(scope), 'utf8').toString('base64url')

  // Explicit '..' segment.
  assert.equal(resolveWallpaperAsset(`wallpaper://asset/${token}/../secret.txt`, allowed, dirs), null)
  // Backslash traversal (Windows path separators).
  assert.equal(resolveWallpaperAsset(`wallpaper://asset/${token}/..%5Csecret.txt`, allowed, dirs), null)
  // Nested traversal that normalizes outside the scope.
  assert.equal(resolveWallpaperAsset(`wallpaper://asset/${token}/sub/../../secret.txt`, allowed, dirs), null)
  // Absolute path as the "relative" part.
  assert.equal(resolveWallpaperAsset(`wallpaper://asset/${token}//etc/passwd`, allowed, dirs), null)
})

test('symlink escape out of the directory scope is rejected', { skip: (() => {
  // Windows symlink creation needs SeCreateSymbolicLinkPrivilege; skip when
  // the environment cannot create the fixture.
  try {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-symprobe-'))
    fs.symlinkSync(probe, path.join(probe, 'link'))
    fs.rmSync(probe, { recursive: true, force: true })
    return false
  } catch {
    return 'symlink creation not permitted on this system'
  }
})() }, () => {
  const scope = makeScope()
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-outside-'))
  fs.writeFileSync(path.join(outsideDir, 'leak.js'), 'leak')
  fs.symlinkSync(outsideDir, path.join(scope, 'link'))
  const dirs = new Set([path.resolve(scope)])
  const allowed = new Set()
  const token = Buffer.from(path.resolve(scope), 'utf8').toString('base64url')
  assert.equal(resolveWallpaperAsset(`wallpaper://asset/${token}/link/leak.js`, allowed, dirs), null)
})

test('sub-resources against a non-scoped base are rejected', () => {
  const scope = makeScope()
  const allowed = new Set()
  const dirs = new Set() // scope NOT whitelisted as a directory
  const token = Buffer.from(path.resolve(scope), 'utf8').toString('base64url')
  assert.equal(resolveWallpaperAsset(`wallpaper://asset/${token}/script.js`, allowed, dirs), null)
})

test('garbage URLs and foreign schemes return null', () => {
  const allowed = new Set()
  const dirs = new Set()
  assert.equal(resolveWallpaperAsset('not-a-url', allowed, dirs), null)
  assert.equal(resolveWallpaperAsset('http://evil/asset/x', allowed, dirs), null)
  assert.equal(resolveWallpaperAsset('wallpaper://otherhost/abc', allowed, dirs), null)
  assert.equal(resolveWallpaperAsset('wallpaper://asset/', allowed, dirs), null)
  assert.equal(resolveWallpaperAsset('wallpaper://asset/!!!!not-base64!!!!', allowed, dirs), null)
})

test('mime mapping covers wallpaper media types', () => {
  assert.equal(wallpaperMime('a/b/c.MP4'), 'video/mp4')
  assert.equal(wallpaperMime('x.html'), 'text/html')
  assert.equal(wallpaperMime('x.jpeg'), 'image/jpeg')
  assert.equal(wallpaperMime('x.weird'), 'application/octet-stream')
})
