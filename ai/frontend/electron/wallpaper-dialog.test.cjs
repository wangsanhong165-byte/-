const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  findWorkshopDirectory,
  inspectWallpaperPath,
  wallpaperDialogOptions,
} = require('./wallpaper-dialog.cjs')

test('offers separate file and Wallpaper Engine directory pickers', () => {
  assert.deepEqual(wallpaperDialogOptions('file').properties, ['openFile'])
  assert.deepEqual(wallpaperDialogOptions('directory').properties, ['openDirectory'])
  assert.ok(wallpaperDialogOptions('file').filters[0].extensions.includes('mp4'))
})

test('recognizes a downloaded video wallpaper project', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-video-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ type: 'video', file: 'loop.mp4' }))
  fs.writeFileSync(path.join(root, 'loop.mp4'), 'video')

  assert.deepEqual(inspectWallpaperPath(root), {
    ok: true,
    path: path.join(root, 'loop.mp4'),
    type: 'video',
    sourceType: 'video',
    label: path.basename(root),
    previewFallback: false,
    warning: undefined,
  })
})

test('uses a Scene preview as an explicitly labelled static fallback', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-scene-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ type: 'scene' }))
  fs.writeFileSync(path.join(root, 'preview.jpg'), 'preview')

  const result = inspectWallpaperPath(root)
  assert.equal(result.ok, true)
  assert.equal(result.type, 'image')
  assert.equal(result.previewFallback, true)
  assert.match(result.warning, /静态预览/)
})

test('accepts web projects with a valid HTML entry (web wallpaper support)', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-web-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ type: 'web', file: 'index.html' }))
  fs.writeFileSync(path.join(root, 'index.html'), '<html></html>')

  const result = inspectWallpaperPath(root)
  assert.equal(result.ok, true)
  assert.equal(result.type, 'web')
  assert.equal(result.sourceType, 'wallpaper-engine-web')
})

test('rejects web projects without a valid HTML entry', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-web-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ type: 'web', file: 'missing.html' }))

  const result = inspectWallpaperPath(root)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'unsupported')
})

test('scans Steam libraryfolders.vdf for a non-default library', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-root-'))
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-library-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  t.after(() => fs.rmSync(library, { recursive: true, force: true }))
  const workshop = path.join(library, 'steamapps', 'workshop', 'content', '431960')
  fs.mkdirSync(workshop, { recursive: true })
  fs.mkdirSync(path.join(root, 'steamapps'), { recursive: true })
  fs.writeFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), `"path"\t\t"${library.replace(/\\/g, '\\\\')}"`)

  const originalProgramFiles = process.env.ProgramFiles
  const originalProgramFilesX86 = process.env['ProgramFiles(x86)']
  const originalSteamPath = process.env.STEAM_PATH
  process.env.STEAM_PATH = root
  process.env.ProgramFiles = root
  process.env['ProgramFiles(x86)'] = root
  try {
    assert.equal(findWorkshopDirectory(), workshop)
  } finally {
    if (originalSteamPath === undefined) delete process.env.STEAM_PATH
    else process.env.STEAM_PATH = originalSteamPath
    if (originalProgramFiles === undefined) delete process.env.ProgramFiles
    else process.env.ProgramFiles = originalProgramFiles
    if (originalProgramFilesX86 === undefined) delete process.env['ProgramFiles(x86)']
    else process.env['ProgramFiles(x86)'] = originalProgramFilesX86
  }
})
