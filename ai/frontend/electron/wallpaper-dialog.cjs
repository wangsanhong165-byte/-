const fs = require('node:fs')
const path = require('node:path')

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.ogv', '.ogg', '.m4v', '.mov'])
const MAX_SCAN_DEPTH = 4

function wallpaperDialogOptions(mode = 'directory') {
  if (mode === 'file') {
    return {
      title: '选择壁纸文件',
      properties: ['openFile'],
      filters: [
        { name: 'Wallpaper media', extensions: [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS].map(ext => ext.slice(1)) },
      ],
    }
  }

  return {
    title: '选择 Wallpaper Engine 壁纸文件夹',
    properties: ['openDirectory'],
  }
}

function isSupportedMedia(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  return null
}

function readProjectMetadata(directory) {
  const projectPath = path.join(directory, 'project.json')
  try {
    const value = JSON.parse(fs.readFileSync(projectPath, 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function collectMediaFiles(directory, depth = 0, output = []) {
  if (depth > MAX_SCAN_DEPTH) return output
  let entries
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return output
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      collectMediaFiles(entryPath, depth + 1, output)
      continue
    }
    const type = isSupportedMedia(entryPath)
    if (!type) continue
    try {
      const stat = fs.statSync(entryPath)
      output.push({ path: entryPath, type, size: stat.size })
    } catch {
      // Ignore files that disappear while Steam is updating a workshop item.
    }
  }
  return output
}

function declaredProjectFile(directory, metadata) {
  const declared = [metadata?.file, metadata?.entry, metadata?.main]
    .filter(value => typeof value === 'string' && value.trim())
  for (const value of declared) {
    const candidate = path.resolve(directory, value)
    if (!candidate.startsWith(path.resolve(directory) + path.sep)) continue
    const type = isSupportedMedia(candidate)
    if (type && fs.existsSync(candidate)) return { path: candidate, type }
  }
  return null
}

function mediaScore(item, declaredPath, type) {
  const name = path.basename(item.path).toLowerCase()
  let score = item.type === type ? 20 : 0
  if (declaredPath && path.resolve(item.path) === path.resolve(declaredPath)) score += 1000
  if (/preview|thumbnail|thumb|icon|poster/.test(name)) score -= 120
  if (/background|wallpaper|main|scene/.test(name)) score += 30
  score += Math.min(20, Math.log10(Math.max(1, item.size)))
  return score
}

function chooseMedia(directory, metadata) {
  const declared = declaredProjectFile(directory, metadata)
  if (declared) return { ...declared, previewFallback: false }

  const media = collectMediaFiles(directory)
  const projectType = String(metadata?.type || metadata?.wallpaperType || '').toLowerCase()
  const preferredType = projectType.includes('video') ? 'video'
    : projectType.includes('image') ? 'image'
      : null

  const nonPreview = media.filter(item => !/preview|thumbnail|thumb|icon|poster/i.test(path.basename(item.path)))
  const candidates = nonPreview.length ? nonPreview : media
  const ordered = [...candidates].sort((a, b) => {
    const aScore = mediaScore(a, null, preferredType || a.type)
    const bScore = mediaScore(b, null, preferredType || b.type)
    return bScore - aScore
  })
  const chosen = (preferredType && ordered.find(item => item.type === preferredType)) || ordered[0]
  if (chosen && nonPreview.length) return { path: chosen.path, type: chosen.type, previewFallback: false }

  // Scene wallpapers are packaged in scene.pkg and cannot be rendered by a
  // normal HTML media element. Their preview is still useful as a static
  // fallback, so expose it explicitly instead of pretending the scene ran.
  const preview = media
    .filter(item => item.type === 'image' && /preview|thumbnail|thumb|poster/i.test(path.basename(item.path)))
    .sort((a, b) => b.size - a.size)[0]
  if (preview) return { path: preview.path, type: 'image', previewFallback: true }
  return null
}

function inspectWallpaperPath(selectedPath) {
  if (typeof selectedPath !== 'string' || !selectedPath.trim()) {
    return { ok: false, code: 'invalid', message: '没有选择有效的壁纸路径。' }
  }

  let stat
  try {
    stat = fs.statSync(selectedPath)
  } catch {
    return { ok: false, code: 'missing', message: '所选壁纸路径不存在或无法读取。' }
  }

  if (stat.isFile()) {
    const type = isSupportedMedia(selectedPath)
    if (!type) {
      return { ok: false, code: 'unsupported', message: '请选择图片或视频文件，或选择 Wallpaper Engine 项目文件夹。' }
    }
    return {
      ok: true,
      path: path.resolve(selectedPath),
      type,
      sourceType: 'file',
      label: path.basename(selectedPath),
      previewFallback: false,
    }
  }

  if (!stat.isDirectory()) {
    return { ok: false, code: 'unsupported', message: '所选路径不是壁纸文件或文件夹。' }
  }

  const metadata = readProjectMetadata(selectedPath)
  const projectType = String(metadata?.type || metadata?.wallpaperType || '').toLowerCase()

  // Web projects: run as iframe wallpaper — the whole project directory gets
  // a protocol scope, the entry file comes from project.json's `file` field.
  if (projectType.includes('web')) {
    const declared = [metadata?.file, metadata?.entry, metadata?.main]
      .filter(value => typeof value === 'string' && value.trim())[0]
    const entry = declared ? path.resolve(selectedPath, declared) : null
    if (entry && entry.startsWith(path.resolve(selectedPath) + path.sep) && fs.existsSync(entry)) {
      return {
        ok: true,
        path: entry,
        type: 'web',
        sourceType: 'wallpaper-engine-web',
        label: typeof metadata?.title === 'string' && metadata.title ? metadata.title : path.basename(selectedPath),
        previewFallback: false,
      }
    }
    return { ok: false, code: 'unsupported', message: '这个 Web 壁纸项目缺少有效的 HTML 入口文件。' }
  }

  const chosen = chooseMedia(selectedPath, metadata)
  if (!chosen) {
    const detail = projectType.includes('scene')
      ? '这个 Wallpaper Engine 项目是 Scene 类型，请从壁纸库中选择它（支持内嵌视频/静态帧提取），或改选其中的视频或图片资源。'
      : '这个文件夹里没有找到可直接播放的图片或视频资源。'
    return { ok: false, code: 'unsupported', message: detail }
  }

  return {
    ok: true,
    path: path.resolve(chosen.path),
    type: chosen.type,
    sourceType: projectType || 'wallpaper-engine',
    label: path.basename(selectedPath),
    previewFallback: Boolean(chosen.previewFallback),
    warning: chosen.previewFallback
      ? '这是 Scene 壁纸的预览图，当前显示静态预览，不会运行 Wallpaper Engine 的粒子和脚本效果。'
      : undefined,
  }
}

function findWorkshopDirectory() {
  const candidates = [
    process.env.STEAM_PATH,
    process.env.STEAM_INSTALL_PATH,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Steam'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Steam'),
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
  ].filter(Boolean)

  const roots = [...candidates]
  for (const steamRoot of candidates) {
    const libraryFile = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf')
    try {
      const content = fs.readFileSync(libraryFile, 'utf8')
      for (const match of content.matchAll(/"path"\s+"([^"]+)"/gi)) {
        const libraryPath = match[1].replace(/\\\\/g, '\\')
        if (libraryPath && !roots.includes(libraryPath)) roots.push(libraryPath)
      }
    } catch {
      // The Steam library manifest is optional; keep conventional roots.
    }
  }

  for (const steamRoot of roots) {
    const workshop = path.join(steamRoot, 'steamapps', 'workshop', 'content', '431960')
    try {
      if (fs.statSync(workshop).isDirectory()) return workshop
    } catch {
      // Try the next conventional Steam install location.
    }
  }
  return undefined
}

module.exports = {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  findWorkshopDirectory,
  inspectWallpaperPath,
  isSupportedMedia,
  wallpaperDialogOptions,
}
