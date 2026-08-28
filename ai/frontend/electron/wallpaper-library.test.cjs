// Tests for the Electron-side Wallpaper Engine library + protocol guards.
// Pure functions are exercised through require(); protocol resolution is
// tested by stubbing the whitelists via exported internals where possible.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const { librariesFromVdf, playlistRows, playlistItemId, resolveSceneMainFile } = require('./wallpaper-library.cjs')
const { extractSceneMedia, lz4DecompressBlock, parsePkg, readPkgEntry } = require('./wallpaper-pkg.cjs')

// ── libraryfolders.vdf parsing ─────────────────────────────────────────────

test('vdf parser extracts every quoted library path (ownership filtered later)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-vdf-'))
  const vdf = path.join(dir, 'libraryfolders.vdf')
  fs.writeFileSync(vdf, [
    '"libraryfolders"',
    '{',
    '\t"0"',
    '\t{',
    '\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"',
    '\t\t"431960"\t\t"5975867542039528974"',
    '\t}',
    '\t"1"',
    '\t{',
    '\t\t"path"\t\t"D:\\\\SteamLibrary"',
    '\t\t"431960"\t\t""',
    '\t}',
    '\t"2"',
    '\t{',
    '\t\t"path"\t\t"E:\\\\Games\\\\Steam"',
    '\t}',
    '}',
  ].join('\n'))
  const libs = await librariesFromVdf(vdf)
  // Discovery collects ALL libraries; per-library WE ownership is checked
  // separately (locate/owning), so extra libraries are harmless probes.
  assert.deepEqual(libs, ['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary', 'E:\\Games\\Steam'])
})

test('vdf parser tolerates missing file', async () => {
  assert.deepEqual(await librariesFromVdf(path.join(os.tmpdir(), 'wp-nope-xyz.vdf')), [])
})

// ── playlist parsing ───────────────────────────────────────────────────────

test('playlistRows reads modern playlists and legacy selectedwallpapers', () => {
  const modern = { general: { playlists: [{ name: 'A', items: ['x'] }] } }
  assert.equal(playlistRows(modern).length, 1)
  const legacy = {
    general: {
      wallpaperconfig: {
        selectedwallpapers: {
          '1080x1920': { playlist: { name: 'L', items: ['y'] } },
          other: null,
        },
      },
    },
  }
  assert.equal(playlistRows(legacy).length, 1)
  assert.equal(playlistRows({}).length, 0)
})

test('playlistItemId matches exact paths, workshop ids, and folder names', () => {
  const byPath = new Map([['c:\\libs\\steamapps\\workshop\\content\\431960\\123\\project.json', 'w123']])
  const byId = new Map([['123', { id: '123' }], ['mywp', { id: 'mywp' }]])
  // Exact path key.
  assert.equal(playlistItemId('C:\\libs\\steamapps\\workshop\\content\\431960\\123\\project.json', byPath, byId), 'w123')
  // Workshop-id path segment.
  assert.equal(playlistItemId('/home/x/431960/123/project.json', byPath, byId), '123')
  // Trailing folder name fallback (install-relative entries).
  assert.equal(playlistItemId('projects\\defaultprojects\\mywp\\project.json', byPath, byId), 'mywp')
  assert.equal(playlistItemId('nothing/matches/this', byPath, byId), null)
})

// ── scene main resolution ──────────────────────────────────────────────────

test('resolveSceneMainFile prefers declared, then scene.pkg, then sole pkg', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-scene-'))
  // No files → null.
  assert.equal(await resolveSceneMainFile(dir, null), null)

  // Only scene.pkg exists; declared scene.json is a lie (workshop pattern).
  fs.writeFileSync(path.join(dir, 'scene.pkg'), 'x')
  assert.equal(await resolveSceneMainFile(dir, 'scene.json'), 'scene.pkg')
  assert.equal(await resolveSceneMainFile(dir, null), 'scene.pkg')

  // Both exist → declared wins.
  fs.writeFileSync(path.join(dir, 'scene.json'), '{}')
  assert.equal(await resolveSceneMainFile(dir, 'scene.json'), 'scene.json')

  // Two pkgs and no declared/standard names → ambiguous → null.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-scene2-'))
  fs.writeFileSync(path.join(dir2, 'a.pkg'), 'x')
  fs.writeFileSync(path.join(dir2, 'b.pkg'), 'x')
  assert.equal(await resolveSceneMainFile(dir2, null), null)
})

// ── PKG container + LZ4 + scene media extraction ──────────────────────────

test('lz4 round-trips an LZ4-compressed buffer', () => {
  // Handcrafted LZ4 block: token 0x30 → 3 literals, match len (0&15)+4 = 4;
  // literals "abc"; match offset 3 → copies "abc" + one overlapping byte.
  const src = Buffer.from([
    0x30, 0x61, 0x62, 0x63, 0x03, 0x00,
  ])
  const out = lz4DecompressBlock(src, 7)
  assert.equal(out.toString('utf8'), 'abcabca')
})

test('parsePkg rejects bad magic and truncated entries with controlled errors', () => {
  const bad = Buffer.alloc(64)
  bad.writeInt32LE(8, 0)
  bad.write('NOPE0001', 4, 'latin1')
  assert.throws(() => parsePkg(bad), /bad magic/)
  // Entry count far beyond the data end → controlled failure, no RangeError.
  const lier = Buffer.alloc(24)
  lier.writeInt32LE(8, 0)
  lier.write('PKGV0001', 4, 'latin1')
  lier.writeInt32LE(100000, 12)
  assert.throws(() => parsePkg(lier), /unexpected end of data/)
})

/** Build a minimal PKG container: u32-len magic + count + entries + data. */
function buildPkg(entries) {
  const magic = 'PKGV0001'
  const header = Buffer.alloc(4 + magic.length + 4)
  header.writeInt32LE(magic.length, 0)
  header.write(magic, 4, 'latin1')
  header.writeInt32LE(entries.length, 4 + magic.length)
  const indexBuffers = []
  const dataBuffers = []
  let dataStart = header.length
  for (const [p] of entries) dataStart += 4 + p.length + 8
  let cursor = dataStart
  for (const [p, data] of entries) {
    const entry = Buffer.alloc(4 + p.length + 8)
    entry.writeInt32LE(p.length, 0)
    entry.write(p, 4, 'latin1')
    entry.writeInt32LE(cursor - dataStart, 4 + p.length)
    entry.writeInt32LE(data.length, 4 + p.length + 4)
    indexBuffers.push(entry)
    dataBuffers.push(data)
    cursor += data.length
  }
  return Buffer.concat([header, ...indexBuffers, ...dataBuffers])
}

test('parsePkg + readPkgEntry round-trip an uncompressed entry', () => {
  const payload = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
  const pkg = buildPkg([['materials\\bg.jpg', payload]])
  const index = parsePkg(pkg)
  assert.equal(index.length, 1)
  assert.equal(index[0].path, 'materials\\bg.jpg')
  assert.equal(index[0].flags, 0)
  const out = readPkgEntry(pkg, index[0])
  assert.deepEqual([...out], [...payload])
})

test('extractSceneMedia finds embedded JPEG payloads and ranks mp4 first', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(24, 7)])

  // JPEG-only scene (photographic texture inside a .tex container).
  const jpgMedia = extractSceneMedia(buildPkg([['materials\\photo.tex', jpeg]]))
  assert.equal(jpgMedia.kind, 'image')
  assert.deepEqual([...jpgMedia.bytes.slice(0, 3)], [0xff, 0xd8, 0xff])

  // MP4 texture (ftyp box) beats JPEG.
  const mp4 = Buffer.alloc(64)
  mp4.writeUInt32BE(24, 0)
  mp4.write('ftyp', 4, 'latin1')
  const mixedMedia = extractSceneMedia(buildPkg([
    ['materials\\main.tex', mp4],
    ['materials\\small.tex', jpeg],
  ]))
  assert.equal(mixedMedia.kind, 'video')
  assert.equal(mixedMedia.path, 'materials\\main.tex')

  // Mask-named videos score below clean ones.
  const maskMedia = extractSceneMedia(buildPkg([
    ['materials\\mask.tex', Buffer.from(mp4)],
    ['materials\\hero.tex', Buffer.from(mp4)],
  ]))
  assert.equal(maskMedia.path, 'materials\\hero.tex')
})
