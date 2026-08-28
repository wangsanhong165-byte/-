// Electron main process — window, tray, lifecycle, ProcessManager
// Manages backend services and provides frameless window + tray UX.

// Guard: ELECTRON_RUN_AS_NODE causes Electron to skip registering the
// built-in 'electron' module. require('electron') then resolves to
// node_modules/electron/index.js (a path string) instead of the API,
// and destructuring crashes with TypeError.
if (process.env.ELECTRON_RUN_AS_NODE) {
  console.error('[FATAL] ELECTRON_RUN_AS_NODE must not be set.');
  console.error('       Unset it before launching: set ELECTRON_RUN_AS_NODE=');
  process.exit(1);
}

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell, dialog, protocol, net } = require('electron')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')
const {
  DEFAULT_MODEL_SIZE,
  fitBoundsToWorkArea,
  getPetBounds,
  getPetConversationBounds,
  selectRestorableBounds,
} = require('./pet-window.cjs')
const { serviceUrl, waitForUrl } = require('./startup-readiness.cjs')
const { canEnterCompanion } = require('./startup-policy.cjs')
const { dialogOptionsFor } = require('./character-asset-dialog.cjs')
const {
  findWorkshopDirectory,
  inspectWallpaperPath,
  wallpaperDialogOptions,
} = require('./wallpaper-dialog.cjs')
const { buildInventory } = require('./wallpaper-library.cjs')
const { extractSceneMedia, extractSceneMediaFromDir } = require('./wallpaper-pkg.cjs')
const { getMediaInfo, transcodeProgress, transcodeToFps } = require('./wallpaper-transcode.cjs')
const {
  resolveWallpaperAsset: protocolResolve,
  wallpaperMime,
  wallpaperProjectUrl,
  wallpaperResourceUrl,
} = require('./wallpaper-protocol.cjs')

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'wallpaper',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
])

// ProcessManager — backend service lifecycle management
const { ProcessManager } = require('../../electron/process-manager.cjs')

// ── Constants ────────────────────────────────────────────────────────

const isDev = process.env.SOULLINK_HOT === '1'
const CONSOLE_LOG = path.join(__dirname, '..', 'console.log')
const ELECTRON_PID_FILE = path.join(__dirname, '..', '..', 'data', 'pids', 'electron.pid')
// Lifecycle status is the source of truth; explicit URLs are development overrides.
const EXPLICIT_APP_URL = isDev ? process.env.VITE_URL : process.env.BRIDGE_URL
// The bootstrap page stays visible while all GPU models are preloaded.
const STARTUP_TIMEOUT_MS = 60_000
const APP_READY_POLL_MS = 500
const APP_LOAD_RETRY_MS = 1_000
const forceHighPerformanceGpu = process.env.SOULLINK_FORCE_HIGH_PERFORMANCE_GPU === '1'

// Keep this opt-in until the same-window A/B probe proves that the discrete
// adapter improves visible Live2D pacing on the current machine. Electron must
// receive the switch before app ready; exposing the result below makes the
// active policy observable instead of silently assuming which GPU Chromium chose.
if (forceHighPerformanceGpu) {
  app.commandLine.appendSwitch('force_high_performance_gpu')
}

// ── State ────────────────────────────────────────────────────────────

const pm = new ProcessManager()
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}
let mainWindow = null
let petConversationWindow = null
let petSnapshot = null
let petConversationVisible = false
let tray = null
let alwaysOnTop = false
let petMode = false
let normalWindowState = null
let forceQuit = false
let ready = false
let shutdownStarted = false
let statusTimer = null
let mainUiLoaded = false
let mainUiLoading = false
let appLoadRetryTimer = null
let appUrl = null
let appReadinessProbe = null
const allowedWallpaperPaths = new Set()

// Frameless-window drag state (driven over IPC, see setupIPC). Polled from
// the main process so dragging stays smooth while the renderer is busy
// rendering the Live2D stage.
let dragOffset = null
let dragPollTimer = null
let dragLastX = null
let dragLastY = null
let dragWindow = null
const stopWindowDrag = () => {
  if (dragPollTimer) {
    clearInterval(dragPollTimer)
    dragPollTimer = null
  }
  dragOffset = null
  dragLastX = null
  dragLastY = null
  dragWindow = null
}

// ── Window creation ──

function createWindow({ transparent = false, bounds = null, assign = true } = {}) {
  const window = new BrowserWindow({
    width: bounds?.width || 1200,
    height: bounds?.height || 800,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: transparent ? 1 : 800,
    minHeight: transparent ? 1 : 600,
    frame: false,
    transparent,
    backgroundColor: transparent ? '#00000000' : '#1a2030',
    hasShadow: !transparent,
    title: 'Aurora',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Keep a visible companion eligible for the display cadence even while
      // another app has focus. Hidden/minimized throttling is managed below.
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  // Keep production logs actionable without blocking Electron's main process.
  window.webContents.on('console-message', (_event, level, message) => {
    if (!isDev && level < 2) return
    const prefix = ['', 'LOG', 'WARN', 'ERR'][level] || 'LOG'
    fs.appendFile(
      CONSOLE_LOG,
      `[${new Date().toISOString()}] [${prefix}] ${message}\n`,
      () => {},
    )
  })

  // Closing the window is a real application exit. The exit path below
  // shuts down the Supervisor and every registered service before Electron
  // terminates, so no tray-only or orphaned backend process remains.
  window.on('close', () => {
    if (window !== mainWindow) return
    if (!forceQuit) {
      forceQuit = true
      app.quit()
    }
  })

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
    if (petConversationWindow === window) petConversationWindow = null
  })

  // A visible companion should render at the display cadence even while a
  // different application has focus. Hidden/minimized windows do not need to
  // burn GPU time, so permit Chromium throttling only in those two states.
  const setBackgroundThrottling = allowed => {
    if (!window.isDestroyed()) window.webContents.setBackgroundThrottling(allowed)
  }
  window.on('minimize', () => setBackgroundThrottling(true))
  window.on('hide', () => setBackgroundThrottling(true))
  window.on('restore', () => setBackgroundThrottling(false))
  window.on('show', () => setBackgroundThrottling(false))

  // Safety net: if the renderer stops sending dragEnd mid-drag (e.g. a
  // renderer crash), stop following the cursor as soon as the window loses
  // focus instead of dragging forever.
  window.on('blur', stopWindowDrag)
  if (assign) mainWindow = window
  return window
}

function withSurfaceQuery(baseUrl, surface) {
  const target = new URL(baseUrl)
  target.searchParams.set('surface', surface)
  return target.toString()
}

function configurePetSurface(window) {
  window.setResizable(false)
  window.setSkipTaskbar(true)
  window.setMenuBarVisibility(false)
  window.setAlwaysOnTop(true)
}

async function recreateWindowForMode(targetPetMode, targetBounds) {
  const oldWindow = mainWindow
  if (!oldWindow || oldWindow.isDestroyed() || !appUrl) return

  const replacement = createWindow({ transparent: targetPetMode, bounds: targetBounds, assign: false })
  const display = screen.getDisplayMatching(targetBounds)
  const conversation = targetPetMode
    ? createWindow({
        transparent: true,
        bounds: getPetConversationBounds(display.workArea),
        assign: false,
      })
    : null
  try {
    await Promise.all([
      replacement.loadURL(targetPetMode ? withSurfaceQuery(appUrl, 'pet-model') : appUrl),
      conversation?.loadURL(withSurfaceQuery(appUrl, 'pet-conversation')),
    ])
    if (petMode !== targetPetMode || mainWindow !== oldWindow) {
      replacement.destroy()
      conversation?.destroy()
      return
    }
    if (targetPetMode) {
      configurePetSurface(replacement)
      configurePetSurface(conversation)
    } else {
      replacement.setAlwaysOnTop(alwaysOnTop)
      if (normalWindowState?.maximized) replacement.maximize()
      if (normalWindowState?.fullScreen) replacement.setFullScreen(true)
    }
    mainWindow = replacement
    const previousConversation = petConversationWindow
    petConversationWindow = conversation
    replacement.show()
    if (petConversationVisible) conversation?.show()
    oldWindow.destroy()
    previousConversation?.destroy()
    if (!targetPetMode) petSnapshot = null
  } catch (error) {
    replacement.destroy()
    conversation?.destroy()
    petMode = !targetPetMode
    console.error(`[Electron] Window mode switch failed: ${error.message}`)
    oldWindow.show()
    throw error
  }
}

async function loadAppUrl() {
  if (mainUiLoaded || mainUiLoading || !appUrl || !mainWindow || mainWindow.isDestroyed()) return
  mainUiLoading = true
  return mainWindow.loadURL(appUrl).then(() => {
    mainUiLoaded = true
    if (statusTimer) {
      clearInterval(statusTimer)
      statusTimer = null
    }
    if (appLoadRetryTimer) {
      clearTimeout(appLoadRetryTimer)
      appLoadRetryTimer = null
    }
    mainUiLoading = false
  }).catch(error => {
    mainUiLoaded = false
    mainUiLoading = false
    mainWindow.loadFile(path.join(__dirname, 'bootstrap', 'index.html'))
    if (!shutdownStarted && !appLoadRetryTimer) {
      appLoadRetryTimer = setTimeout(() => {
        appLoadRetryTimer = null
        void loadAppUrl()
      }, APP_LOAD_RETRY_MS)
    }
    mainWindow.webContents.send('lifecycle:error', `角色界面加载失败：${error.message}`)
  })
}

function beginCompanionLoad(status) {
  if (!canEnterCompanion(status)) return false
  ready = true
  appUrl = appUrl || EXPLICIT_APP_URL || serviceUrl(status, isDev ? 'frontend' : 'bridge')
  if (!appUrl || mainUiLoaded || appReadinessProbe) return Boolean(appUrl)

  appReadinessProbe = waitForUrl(appUrl, {
    intervalMs: APP_READY_POLL_MS,
    timeoutMs: STARTUP_TIMEOUT_MS,
    shouldStop: () => mainUiLoaded || shutdownStarted,
  }).then(available => {
    if (available === false && !mainUiLoaded && !shutdownStarted) {
      const message = 'Startup blocked: Bridge UI URL did not become ready'
      console.error(`[Electron] ${message}`)
      mainWindow?.webContents.send('lifecycle:error', message)
      return
    }
    if (available === true && !mainUiLoaded && !shutdownStarted) {
      return loadAppUrl()
    }
  }).finally(() => {
    appReadinessProbe = null
  })
  return true
}

// ── System tray ──

function showCompanionWindows() {
  mainWindow?.show()
  if (petMode && petConversationVisible) petConversationWindow?.show()
}

function hideCompanionWindows() {
  mainWindow?.hide()
  if (petMode) petConversationWindow?.hide()
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示模型', click: showCompanionWindows },
    { label: '隐藏模型', click: hideCompanionWindows },
    {
      label: petConversationVisible ? '隐藏对话' : '打开对话',
      enabled: petMode,
      click: () => {
        if (!petMode || !petConversationWindow || petConversationWindow.isDestroyed()) return
        petConversationVisible = !petConversationVisible
        if (petConversationVisible) {
          petConversationWindow.show()
          petConversationWindow.focus()
        } else {
          petConversationWindow.hide()
        }
        refreshTrayMenu()
      },
    },
    {
      label: '返回主界面',
      enabled: petMode,
      click: () => mainWindow?.webContents.send('pet:exit-request'),
    },
    { type: 'separator' },
    {
      label: '置顶显示',
      type: 'checkbox',
      checked: alwaysOnTop,
      click: (menuItem) => {
        alwaysOnTop = menuItem.checked
        if (mainWindow) mainWindow.setAlwaysOnTop(petMode || alwaysOnTop)
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => {
      forceQuit = true
      app.quit()
    }},
  ]))
}

function createTray() {
  // Try to find an icon, fall back to empty
  let icon
  const iconPath = path.join(__dirname, '..', '..', 'electron', 'tray-icon.png')
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath)
  } else {
    icon = nativeImage.createEmpty()
  }

  tray = new Tray(icon)
  tray.setToolTip('Aurora')
  refreshTrayMenu()
  tray.on('double-click', showCompanionWindows)
}

// ── IPC handlers (window controls) ──

function setupIPC() {
  ipcMain.handle('performance:getElectronDiagnostics', async () => {
    const window = mainWindow
    const liveWindow = Boolean(window && !window.isDestroyed())
    const bounds = liveWindow ? window.getBounds() : null
    const display = bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay()
    let gpuInfo = null
    let gpuInfoError = null
    try {
      gpuInfo = await app.getGPUInfo('complete')
    } catch (error) {
      gpuInfoError = error instanceof Error ? error.message : String(error)
    }

    return {
      capturedAt: new Date().toISOString(),
      forceHighPerformanceGpu,
      hardwareAccelerationEnabled: typeof app.isHardwareAccelerationEnabled === 'function'
        ? app.isHardwareAccelerationEnabled()
        : null,
      gpuFeatureStatus: app.getGPUFeatureStatus(),
      gpuInfo,
      gpuInfoError,
      display: display ? {
        id: display.id,
        label: display.label,
        displayFrequency: display.displayFrequency,
        scaleFactor: display.scaleFactor,
        size: display.size,
        workArea: display.workArea,
      } : null,
      window: liveWindow ? {
        visible: window.isVisible(),
        minimized: window.isMinimized(),
        focused: window.isFocused(),
        petMode,
        bounds,
        backgroundThrottling: window.webContents.getBackgroundThrottling(),
      } : null,
    }
  })

  ipcMain.handle('character:selectAsset', async (_event, kind) => {
    const result = await dialog.showOpenDialog(
      mainWindow,
      dialogOptionsFor(kind, path.join(__dirname, '..', '..')),
    )
    return result.canceled ? '' : (result.filePaths[0] || '')
  })

  ipcMain.handle('wallpaper:select', async (_event, mode = 'directory') => {
    const result = await dialog.showOpenDialog(mainWindow, wallpaperDialogOptions(mode))
    if (result.canceled || !result.filePaths[0]) return { ok: false, code: 'canceled' }
    return createWallpaperResource(inspectWallpaperPath(result.filePaths[0]))
  })

  ipcMain.handle('wallpaper:openWorkshop', async () => {
    const directory = findWorkshopDirectory()
    if (!directory) {
      return { ok: false, message: '没有找到 Steam 的 Wallpaper Engine 创意工坊目录，请确认 Steam 和壁纸引擎已经安装。' }
    }
    const error = await shell.openPath(directory)
    return error ? { ok: false, message: error } : { ok: true, path: directory }
  })

  // Wallpaper Engine library: full inventory (wallpapers + WE playlists).
  ipcMain.handle('wallpaper:inventory', async () => {
    try {
      const inventory = await wallpaperInventoryPayload()
      // Thumbnail previews are served through the same guarded protocol:
      // whitelist every preview the picker is about to render.
      for (const wallpaper of inventory.wallpapers) {
        if (wallpaper.previewPath) {
          allowedWallpaperPaths.add(path.resolve(wallpaper.previewPath))
        }
      }
      return { ok: true, inventory }
    } catch (error) {
      return { ok: false, message: `壁纸库扫描失败：${error instanceof Error ? error.message : String(error)}` }
    }
  })

  // Pick a wallpaper from the library inventory (renderer passes the entry).
  ipcMain.handle('wallpaper:pick', async (_event, wallpaper) => {
    try {
      return await pickWallpaperFromLibrary(wallpaper)
    } catch (error) {
      return { ok: false, message: `选择壁纸失败：${error instanceof Error ? error.message : String(error)}` }
    }
  })

  // Video wallpaper metadata (resolution/codec/fps) for the fps-cap decision.
  ipcMain.handle('wallpaper:media-info', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !allowedWallpaperPaths.has(path.resolve(filePath))) {
      return { ok: false }
    }
    return { ok: true, info: getMediaInfo(filePath) }
  })

  // Frame-skip transcode to a capped fps; returns the transcoded file URL
  // (whitelisted) or ok:false with a reason — the client keeps the original.
  ipcMain.handle('wallpaper:transcode', async (_event, filePath, fps) => {
    if (typeof filePath !== 'string' || !allowedWallpaperPaths.has(path.resolve(filePath))) {
      return { ok: false, reason: 'not-whitelisted' }
    }
    try {
      const out = await transcodeToFps(path.resolve(filePath), Number(fps))
      if (!out) return { ok: false, reason: 'not-needed-or-failed' }
      allowedWallpaperPaths.add(path.resolve(out))
      return { ok: true, url: wallpaperResourceUrl(out), path: out }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('wallpaper:transcode-progress', (_event, filePath, fps) => {
    if (typeof filePath !== 'string' || !allowedWallpaperPaths.has(path.resolve(filePath))) {
      return { ok: false }
    }
    try {
      return { ok: true, progress: transcodeProgress(path.resolve(filePath), Number(fps)) }
    } catch {
      return { ok: true, progress: null }
    }
  })

  // Window controls (from existing UI)
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize()
  })

  ipcMain.handle('window:close', () => {
    mainWindow?.close()
  })

  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
      return false
    }
    mainWindow.maximize()
    return true
  })

  ipcMain.handle('window:isMaximized', () => {
    return mainWindow?.isMaximized() ?? false
  })

  ipcMain.handle('window:setAlwaysOnTop', (_event, value) => {
    alwaysOnTop = value
    if (mainWindow) {
      mainWindow.setAlwaysOnTop(petMode || value)
    }
    return alwaysOnTop
  })

  ipcMain.handle('window:setPetMode', async (_event, enabled) => {
    if (!mainWindow) return { enabled: false }
    if (enabled && !petMode) {
      const currentBounds = mainWindow.getBounds()
      const maximized = mainWindow.isMaximized()
      const fullScreen = mainWindow.isFullScreen()
      const bounds = selectRestorableBounds({
        current: currentBounds,
        normal: mainWindow.getNormalBounds(),
        maximized,
        fullScreen,
      })
      normalWindowState = {
        bounds,
        maximized,
        fullScreen,
      }
      const display = screen.getDisplayMatching(bounds)
      const petBounds = getPetBounds(display.workArea)
      petConversationVisible = false
      petMode = true
      await recreateWindowForMode(true, petBounds)
      refreshTrayMenu()
      return { enabled: true, bounds: petBounds }
    } else if (!enabled && petMode) {
      let normalBounds = mainWindow.getBounds()
      if (normalWindowState) {
        const display = screen.getDisplayMatching(normalWindowState.bounds)
        normalBounds = fitBoundsToWorkArea(normalWindowState.bounds, display.workArea)
      }
      petMode = false
      await recreateWindowForMode(false, normalBounds)
      refreshTrayMenu()
      return { enabled: false, bounds: normalBounds }
    }
    return { enabled: petMode, bounds: mainWindow.getBounds() }
  })

  // The model renderer remains the only Runtime/WebSocket/audio owner.  The
  // compact conversation renderer receives a serializable UI snapshot and
  // sends user commands back through Electron, avoiding a second backend
  // connection and duplicate TTS/initiative subscriptions.
  ipcMain.on('pet:publishSnapshot', (event, snapshot) => {
    if (!petMode || !mainWindow || event.sender !== mainWindow.webContents) return
    petSnapshot = snapshot
    if (petConversationWindow && !petConversationWindow.isDestroyed()) {
      petConversationWindow.webContents.send('pet:snapshot', snapshot)
    }
  })

  ipcMain.handle('pet:getSnapshot', () => petSnapshot)

  ipcMain.on('pet:command', (event, command) => {
    if (
      !petMode
      || !mainWindow
      || mainWindow.isDestroyed()
      || !petConversationWindow
      || event.sender !== petConversationWindow.webContents
    ) return
    mainWindow.webContents.send('pet:command', command)
  })

  ipcMain.on('pet:setConversationVisible', (_event, visible) => {
    if (!petMode || !petConversationWindow || petConversationWindow.isDestroyed()) return
    petConversationVisible = Boolean(visible)
    if (petConversationVisible) petConversationWindow.show()
    else petConversationWindow.hide()
    refreshTrayMenu()
  })

  ipcMain.on('pet:resizeModel', (event, scaleFactor) => {
    if (!petMode || !mainWindow || event.sender !== mainWindow.webContents) return
    const factor = Number(scaleFactor)
    if (!Number.isFinite(factor) || factor <= 0) return
    const bounds = mainWindow.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const workArea = display.workArea
    const aspect = DEFAULT_MODEL_SIZE.height / DEFAULT_MODEL_SIZE.width
    const minWidth = Math.min(DEFAULT_MODEL_SIZE.width * 0.55, workArea.width)
    const maxWidth = Math.min(DEFAULT_MODEL_SIZE.width * 1.6, workArea.width)
    const width = Math.round(Math.max(minWidth, Math.min(maxWidth, bounds.width * factor)))
    const height = Math.round(Math.min(workArea.height, width * aspect))
    const cursor = screen.getCursorScreenPoint()
    const anchorX = Math.max(0, Math.min(1, (cursor.x - bounds.x) / bounds.width))
    const anchorY = Math.max(0, Math.min(1, (cursor.y - bounds.y) / bounds.height))
    mainWindow.setBounds(fitBoundsToWorkArea({
      x: Math.round(cursor.x - anchorX * width),
      y: Math.round(cursor.y - anchorY * height),
      width,
      height,
    }, workArea))
  })

  // ── Window dragging (frameless fallback) ──
  // CSS -webkit-app-region proved unreliable for moving this window, so the
  // renderer drives the move explicitly: it sends dragStart on pointerdown in
  // the title bar and dragEnd on pointerup, and the main process polls the OS
  // cursor position to keep the window glued to it while a drag is active.
  ipcMain.on('window:dragStart', (event) => {
    const requestedWindow = BrowserWindow.fromWebContents(event.sender)
    if (!requestedWindow || requestedWindow.isDestroyed()) return
    if (requestedWindow.isMaximized() || requestedWindow.isFullScreen()) return
    stopWindowDrag()
    dragWindow = requestedWindow
    const cursor = screen.getCursorScreenPoint()
    const [winX, winY] = dragWindow.getPosition()
    const [winW, winH] = dragWindow.getSize()
    dragOffset = { offsetX: cursor.x - winX, offsetY: cursor.y - winY }
    // setBounds with an explicit size, NOT setPosition: on this Windows host
    // repeated setPosition calls let the DWM ratchet the frameless window's
    // size upward (it re-applies the inflated size on each call), so the
    // window visibly grows while being dragged. Pinning the size on every
    // move keeps the window from growing.
    dragPollTimer = setInterval(() => {
      if (!dragOffset || !dragWindow || dragWindow.isDestroyed()) {
        stopWindowDrag()
        return
      }
      const cursorNow = screen.getCursorScreenPoint()
      const x = Math.round(cursorNow.x - dragOffset.offsetX)
      const y = Math.round(cursorNow.y - dragOffset.offsetY)
      if (x === dragLastX && y === dragLastY) return
      dragLastX = x
      dragLastY = y
      dragWindow.setBounds({ x, y, width: winW, height: winH })
    }, 16)
  })

  ipcMain.on('window:dragEnd', () => {
    stopWindowDrag()
  })

  ipcMain.handle('app:getSettings', () => {
    return {
      alwaysOnTop,
      platform: process.platform,
    }
  })

  // ProcessManager / lifecycle IPC (new)
  ipcMain.handle('get-status', () => {
    return pm.refresh()
  })
  ipcMain.handle('lifecycle:getSnapshot', () => pm.refresh())
  ipcMain.handle('lifecycle:command', async (_event, command) => {
    if (command === 'restart') return pm.restartAll()
    if (command === 'stop') return pm.stopAll()
    throw new Error(`unsupported lifecycle command: ${command}`)
  })
  ipcMain.handle('lifecycle:openLogs', () => shell.openPath(pm.getLogsDir()))

  ipcMain.handle('get-logs-dir', () => {
    return pm.getLogsDir()
  })

  ipcMain.handle('restart-services', async () => {
    await pm.restartAll()
    return { ok: true }
  })

  ipcMain.handle('is-ready', () => {
    return pm.isReady()
  })

  ipcMain.handle('get-service-log', async (_event, serviceName) => {
    const logPath = path.join(pm.getLogsDir(), `${serviceName}.log`)
    try {
      const content = fs.readFileSync(logPath, 'utf-8')
      const lines = content.split('\n').slice(-100)
      return { ok: true, lines }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
}

function createWallpaperResource(result) {
  if (!result?.ok || !result.path) return result
  allowedWallpaperPaths.add(path.resolve(result.path))
  return {
    ...result,
    url: wallpaperResourceUrl(result.path),
  }
}

// Directory-scoped access for WEB wallpapers: an entry maps a project root
// directory; files inside it resolve with traversal guards.
const allowedWallpaperDirs = new Set()

function allowWallpaperDirectory(dirPath) {
  allowedWallpaperDirs.add(path.resolve(dirPath))
}

function resolveWallpaperAsset(requestUrl) {
  return protocolResolve(requestUrl, allowedWallpaperPaths, allowedWallpaperDirs)
}

function registerWallpaperProtocol() {
  try {
    const settingsPath = path.join(__dirname, '..', '..', 'data', 'settings.json')
    const persisted = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    const backgroundPath = persisted?.backgroundPath
    if (typeof backgroundPath === 'string' && backgroundPath) {
      const inspected = inspectWallpaperPath(backgroundPath)
      if (inspected.ok && inspected.path) {
        allowedWallpaperPaths.add(path.resolve(inspected.path))
        // Web wallpapers whitelist their whole project directory so the
        // iframe can load relative scripts/assets.
        const sourceType = String(inspected.sourceType || '').toLowerCase()
        if (sourceType.includes('web')) {
          allowWallpaperDirectory(path.dirname(path.resolve(inspected.path)))
        }
      }
    }
  } catch {
    // A missing or invalid settings file is handled by the normal defaults.
  }

  protocol.handle('wallpaper', async request => {
    const target = resolveWallpaperAsset(request.url)
    if (!target) return new Response('Wallpaper resource unavailable', { status: 404 })
    let stat
    try { stat = fs.statSync(target.filePath) } catch {
      return new Response('Wallpaper resource unavailable', { status: 404 })
    }
    if (!stat.isFile()) return new Response('Wallpaper resource unavailable', { status: 404 })
    // Directory-scoped sub-resources skip the single-file inspector (any
    // file type inside a web project is legitimately loadable).
    if (!target.dirScope) {
      const inspected = inspectWallpaperPath(target.filePath)
      if (!inspected.ok || inspected.type === undefined || inspected.path !== target.filePath) {
        return new Response('Wallpaper resource unavailable', { status: 404 })
      }
    }
    try {
      const response = await net.fetch(pathToFileURL(target.filePath).toString())
      const headers = new Headers(response.headers)
      headers.set('Content-Type', wallpaperMime(target.filePath))
      // Web wallpaper HTML entry: inject the Wallpaper Engine JS API shim.
      // Many workshop web wallpapers call wallpaperRegisterAudioListener etc.
      // unconditionally and die on a missing symbol; the no-op shim keeps
      // them rendering (a gap in the reference plugin — we do better).
      if (target.dirScope && /\.html?$/i.test(target.filePath)) {
        const html = await response.text()
        const shim = buildWeApiShim()
        const injected = html.includes('<head>')
          ? html.replace('<head>', `<head><script>${shim}</script>`)
          : `<script>${shim}</script>${html}`
        return new Response(injected, { status: 200, headers })
      }
      return new Response(response.body, { status: response.status, headers })
    } catch {
      return new Response('Wallpaper resource unavailable', { status: 404 })
    }
  })
}

/**
 * No-op Wallpaper Engine web API shim (sandboxed iframe context). Registers
 * every documented `wallpaper*` global so workshop scripts never hit a
 * ReferenceError; listener registration accepts and forgets callbacks;
 * `wallpaperRequestRandomFileForProperty` resolves an empty data URL so
 * user-image wallpapers still run their normal path.
 */
function buildWeApiShim() {
  return `
(function () {
  if (window.__auroraWeShim) return;
  window.__auroraWeShim = true;
  var noop = function () {};
  var listeners = {};
  function register(name) {
    window['wallpaper' + name] = function (callback) {
      (listeners[name] = listeners[name] || []).push(callback);
    };
  }
  ['RegisterAudioListener', 'RegisterMouseListener', 'RegisterTimeListener',
   'RegisterMoveListener', 'RegisterScrollListener', 'RegisterTouchpadListener',
   'RegisterPropertyListener', 'RegisterSchemeListener', 'RegisterLanguageListener',
   'RegisterMediaPlaybackListener', 'RegisterGamePresenceListener'].forEach(register);
  window.wallpaperPropertyListener = { applyUserProperties: noop, onPropertiesChanged: noop };
  window.wallpaperRequestRandomFileForProperty = function (propertyName, callback) {
    if (typeof callback === 'function') callback('');
  };
  window.wallpaperRegisterAudioListener = window.wallpaperRegisterAudioListener || function (callback) {
    (listeners.AudioListener = listeners.AudioListener || []).push(callback);
  };
  var defaultUserProps = {};
  try {
    window.wallpaperPropertyListener && window.wallpaperPropertyListener.applyUserProperties(defaultUserProps);
  } catch (e) {}
})();
`.trim()
}

// ── Wallpaper Engine library IPC ───────────────────────────────────────

let inventoryCache = { t: 0, payload: null }

async function wallpaperInventoryPayload() {
  if (inventoryCache.payload && Date.now() - inventoryCache.t < 30_000) {
    return inventoryCache.payload
  }
  const payload = await buildInventory()
  inventoryCache = { t: Date.now(), payload }
  return payload
}

/** Extracted scene media (embedded MP4/JPEG) cache: key = entry path+mtime. */
function sceneMediaCachePaths(entryPath) {
  const st = fs.statSync(entryPath)
  const key = Buffer.from(`${entryPath}|${Math.round(st.mtimeMs)}`, 'utf8').toString('base64url')
  const dir = path.join(__dirname, '..', '..', 'data', 'cache', 'wallpaper-scenes')
  fs.mkdirSync(dir, { recursive: true })
  return {
    dir,
    cacheFile: (kind) => path.join(dir, `sm_${key}${kind === 'video' ? '.mp4' : '.jpg'}`),
    kindFile: () => path.join(dir, `sm_${key}.kind`),
  }
}

async function extractSceneMediaCached(entryPath) {
  const lower = entryPath.toLowerCase()
  const isJsonScene = lower.endsWith('.json')
  try {
    const stat = await fs.promises.stat(entryPath)
    if (stat.isDirectory() || isJsonScene) {
      const dir = isJsonScene ? path.dirname(entryPath) : entryPath
      const pkg = await fs.promises.readdir(dir)
        .then(names => names.find(n => n.toLowerCase() === 'scene.pkg'))
        .catch(() => null)
      if (pkg) return await extractSceneMediaCached(path.join(dir, pkg))
    }
  } catch { /* fall through to direct extraction */ }

  const paths = sceneMediaCachePaths(entryPath)
  for (const kind of ['video', 'image']) {
    const file = paths.cacheFile(kind)
    const kindFile = paths.kindFile()
    if (fs.existsSync(file) && fs.existsSync(kindFile)
      && fs.readFileSync(kindFile, 'utf8') === kind) {
      allowedWallpaperPaths.add(path.resolve(file))
      return { kind, url: wallpaperResourceUrl(file), path: file }
    }
  }

  let media = null
  try {
    const bytes = await fs.promises.readFile(entryPath)
    media = extractSceneMedia(new Uint8Array(bytes))
  } catch { media = null }
  if (!media) return null

  const outFile = paths.cacheFile(media.kind)
  try {
    const tmp = `${outFile}.tmp${process.pid}`
    await fs.promises.writeFile(tmp, media.bytes)
    await fs.promises.rename(tmp, outFile)
    fs.writeFileSync(paths.kindFile(), media.kind, 'utf8')
    allowedWallpaperPaths.add(path.resolve(outFile))
    return { kind: media.kind, url: wallpaperResourceUrl(outFile), path: outFile }
  } catch {
    return null
  }
}

async function pickWallpaperFromLibrary(wallpaper) {
  if (!wallpaper || typeof wallpaper !== 'object' || !wallpaper.entryPath) {
    return { ok: false, code: 'invalid', message: '无效的壁纸条目。' }
  }
  const entryPath = path.resolve(wallpaper.entryPath)
  if (!(await fs.promises.stat(entryPath).then(s => s.isFile()).catch(() => false))) {
    return { ok: false, code: 'missing', message: '壁纸文件不存在，Steam 可能在更新它。' }
  }

  if (wallpaper.type === 'web') {
    // Whole-project directory scope for the iframe; the entry URL carries
    // the directory token + relative entry path so the wallpaper's own
    // relative <script>/<img> refs resolve inside the scope.
    const dir = path.dirname(entryPath)
    allowWallpaperDirectory(dir)
    allowedWallpaperPaths.add(entryPath)
    return {
      ok: true,
      type: 'web',
      path: entryPath,
      url: wallpaperProjectUrl(dir, entryPath),
      label: wallpaper.title || path.basename(dir),
      sourceType: 'wallpaper-engine-web',
    }
  }

  if (wallpaper.type === 'scene') {
    const media = await extractSceneMediaCached(entryPath)
    if (media && media.kind === 'video') {
      return {
        ok: true,
        type: 'video',
        path: media.path,
        url: media.url,
        label: wallpaper.title || path.basename(path.dirname(entryPath)),
        sourceType: 'wallpaper-engine-scene-video',
      }
    }
    if (media && media.kind === 'image') {
      return {
        ok: true,
        type: 'image',
        path: media.path,
        url: media.url,
        label: wallpaper.title || path.basename(path.dirname(entryPath)),
        sourceType: 'wallpaper-engine-scene-frame',
      }
    }
    // Fall back to the project preview image if present.
    if (wallpaper.previewPath && await fs.promises.stat(wallpaper.previewPath).then(s => s.isFile()).catch(() => false)) {
      allowedWallpaperPaths.add(path.resolve(wallpaper.previewPath))
      return {
        ok: true,
        type: 'image',
        path: path.resolve(wallpaper.previewPath),
        url: wallpaperResourceUrl(wallpaper.previewPath),
        label: wallpaper.title || path.basename(path.dirname(entryPath)),
        sourceType: 'wallpaper-engine-scene-preview',
      }
    }
    return { ok: false, code: 'unsupported', message: '这个场景壁纸无法提取内嵌媒体，也没有预览图可用。' }
  }

  // video / image: the entry file itself
  allowedWallpaperPaths.add(entryPath)
  const type = wallpaper.type === 'video' ? 'video' : 'image'
  return {
    ok: true,
    type,
    path: entryPath,
    url: wallpaperResourceUrl(entryPath),
    label: wallpaper.title || path.basename(entryPath),
    sourceType: `wallpaper-engine-${type}`,
  }
}

// ── App lifecycle ──

app.whenReady().then(async () => {
  registerWallpaperProtocol()
  fs.mkdirSync(path.dirname(ELECTRON_PID_FILE), { recursive: true })
  fs.writeFileSync(ELECTRON_PID_FILE, String(process.pid), 'utf8')
  // Clear previous console log
  try { fs.unlinkSync(CONSOLE_LOG) } catch (_) {}

  setupIPC()
  createWindow()
  await mainWindow.loadFile(path.join(__dirname, 'bootstrap', 'index.html'))

  if (isDev) {
    console.log('[Electron] Dev mode — starting backend services...')
  }

  // Start services BEFORE showing the window.
  // The bootstrap page will then receive live lifecycle:snapshot events
  // showing real-time service startup progress instead of stale "blocked".
  const startPromise = pm.startAll()

  // Poll only the in-memory startup snapshot while the sequential GPU preload
  // is running. loadAppUrl() clears this timer after the main UI is loaded.
  let statusPollCounter = 0
  statusTimer = setInterval(() => {
    statusPollCounter++
    // Refresh the orchestrator snapshot every 30 polls (15s @ 500ms each,
    // matches MIN_REFRESH_INTERVAL so the rate-limit never kicks in).
    if (statusPollCounter % 30 === 0) {
      pm.refresh()
    }
    const status = pm.getStatus()
    if (mainWindow?.isDestroyed?.()) return
    mainWindow?.webContents.send('lifecycle:snapshot', status)
    beginCompanionLoad(status)
  }, 500)

  // Now show the window — services are already starting in the background.
  mainWindow.show()
  createTray()

  startPromise.then(status => {
    mainWindow?.webContents.send('lifecycle:snapshot', status)
    if (!beginCompanionLoad(status)) {
      const message = `Startup blocked: text services are not ready (${status?.availability || 'BLOCKED'})`
      console.error(`[Electron] ${message}`)
      mainWindow?.webContents.send('lifecycle:error', message)
    }
  }).catch(err => {
    console.error('[Electron] Failed to start services:', err)
    mainWindow?.webContents.send('lifecycle:error', err.message)
    // Keep the bootstrap page visible so the user can see the failure state.
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else {
      mainWindow?.show()
    }
  })
})

app.on('window-all-closed', () => {
  if (!forceQuit) {
    forceQuit = true
    app.quit()
  }
})

app.on('before-quit', async (event) => {
  if (shutdownStarted) return
  event.preventDefault()
  shutdownStarted = true
  if (statusTimer) clearInterval(statusTimer)
  if (appLoadRetryTimer) clearTimeout(appLoadRetryTimer)
  if (isDev) {
    console.log('[Electron] Shutting down all services...')
  }

  try {
    await pm.shutdownAll()
  } catch (err) {
    console.error('[Electron] Lifecycle shutdown failed:', err)
  } finally {
    try { fs.unlinkSync(ELECTRON_PID_FILE) } catch (_) {}
    app.exit(0)
  }
})
