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
  fitBoundsToWorkArea,
  getPetBounds,
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
const stopWindowDrag = () => {
  if (dragPollTimer) {
    clearInterval(dragPollTimer)
    dragPollTimer = null
  }
  dragOffset = null
  dragLastX = null
  dragLastY = null
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
    title: 'Monika Companion',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // A desktop companion must keep animating while another app has focus.
      // Chromium's default background throttling otherwise collapses the
      // Live2D loop to single-digit FPS whenever this window is unfocused.
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
  })

  // Safety net: if the renderer stops sending dragEnd mid-drag (e.g. a
  // renderer crash), stop following the cursor as soon as the window loses
  // focus instead of dragging forever.
  window.on('blur', stopWindowDrag)
  if (assign) mainWindow = window
  return window
}

async function recreateWindowForMode(targetPetMode, targetBounds) {
  const oldWindow = mainWindow
  if (!oldWindow || oldWindow.isDestroyed() || !appUrl) return

  const replacement = createWindow({
    transparent: targetPetMode,
    bounds: targetBounds,
    assign: false,
  })
  try {
    await replacement.loadURL(appUrl)
    if (petMode !== targetPetMode || mainWindow !== oldWindow) {
      replacement.destroy()
      return
    }
    if (targetPetMode) {
      replacement.setResizable(false)
      replacement.setSkipTaskbar(true)
      replacement.setMenuBarVisibility(false)
      replacement.setIgnoreMouseEvents(true, { forward: true })
      replacement.setAlwaysOnTop(true)
    } else {
      replacement.setAlwaysOnTop(alwaysOnTop)
      if (normalWindowState?.maximized) replacement.maximize()
      if (normalWindowState?.fullScreen) replacement.setFullScreen(true)
    }
    mainWindow = replacement
    replacement.show()
    oldWindow.destroy()
  } catch (error) {
    replacement.destroy()
    petMode = !targetPetMode
    console.error(`[Electron] Window mode switch failed: ${error.message}`)
    oldWindow.show()
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
  tray.setToolTip('Monika Companion')

  const contextMenu = Menu.buildFromTemplate([
    { label: '显示窗口', click: () => mainWindow?.show() },
    { label: '隐藏窗口', click: () => mainWindow?.hide() },
    {
      label: '返回舞台模式',
      click: () => mainWindow?.webContents.send('pet:exit-request'),
    },
    { type: 'separator' },
    {
      label: '置顶显示',
      type: 'checkbox',
      checked: alwaysOnTop,
      click: (menuItem) => {
        alwaysOnTop = menuItem.checked
        if (mainWindow) {
          mainWindow.setAlwaysOnTop(petMode || alwaysOnTop)
        }
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => {
      forceQuit = true
      app.quit()
    }},
  ])

  tray.setContextMenu(contextMenu)
  tray.on('double-click', () => mainWindow?.show())
}

// ── IPC handlers (window controls) ──

function setupIPC() {
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

  ipcMain.handle('window:setPetMode', (_event, enabled) => {
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
      petMode = true
      void recreateWindowForMode(true, petBounds)
      return { enabled: true, bounds: petBounds }
    } else if (!enabled && petMode) {
      let normalBounds = mainWindow.getBounds()
      if (normalWindowState) {
        const display = screen.getDisplayMatching(normalWindowState.bounds)
        normalBounds = fitBoundsToWorkArea(normalWindowState.bounds, display.workArea)
      }
      petMode = false
      void recreateWindowForMode(false, normalBounds)
      return { enabled: false, bounds: normalBounds }
    }
    return { enabled: petMode, bounds: mainWindow.getBounds() }
  })

  ipcMain.on('pet:setMousePassthrough', (_event, passthrough) => {
    if (!mainWindow || mainWindow.isDestroyed() || !petMode) return
    mainWindow.setIgnoreMouseEvents(Boolean(passthrough), { forward: true })
  })

  // ── Window dragging (frameless fallback) ──
  // CSS -webkit-app-region proved unreliable for moving this window, so the
  // renderer drives the move explicitly: it sends dragStart on pointerdown in
  // the title bar and dragEnd on pointerup, and the main process polls the OS
  // cursor position to keep the window glued to it while a drag is active.
  ipcMain.on('window:dragStart', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMaximized() || mainWindow.isFullScreen()) return
    stopWindowDrag()
    const cursor = screen.getCursorScreenPoint()
    const [winX, winY] = mainWindow.getPosition()
    const [winW, winH] = mainWindow.getSize()
    dragOffset = { offsetX: cursor.x - winX, offsetY: cursor.y - winY }
    // setBounds with an explicit size, NOT setPosition: on this Windows host
    // repeated setPosition calls let the DWM ratchet the frameless window's
    // size upward (it re-applies the inflated size on each call), so the
    // window visibly grows while being dragged. Pinning the size on every
    // move keeps the window from growing.
    dragPollTimer = setInterval(() => {
      if (!dragOffset || !mainWindow || mainWindow.isDestroyed()) {
        stopWindowDrag()
        return
      }
      const cursorNow = screen.getCursorScreenPoint()
      const x = Math.round(cursorNow.x - dragOffset.offsetX)
      const y = Math.round(cursorNow.y - dragOffset.offsetY)
      if (x === dragLastX && y === dragLastY) return
      dragLastX = x
      dragLastY = y
      mainWindow.setBounds({ x, y, width: winW, height: winH })
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

function wallpaperResourceUrl(filePath) {
  const token = Buffer.from(path.resolve(filePath), 'utf8').toString('base64url')
  return `wallpaper://asset/${token}`
}

function decodeWallpaperResourceUrl(requestUrl) {
  try {
    const parsed = new URL(requestUrl)
    if (parsed.protocol !== 'wallpaper:' || parsed.hostname !== 'asset') return null
    const token = parsed.pathname.replace(/^\/+/, '')
    if (!token) return null
    return Buffer.from(token, 'base64url').toString('utf8')
  } catch {
    return null
  }
}

function registerWallpaperProtocol() {
  try {
    const settingsPath = path.join(__dirname, '..', '..', 'data', 'settings.json')
    const persisted = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    const backgroundPath = persisted?.backgroundPath
    if (typeof backgroundPath === 'string' && backgroundPath) {
      const inspected = inspectWallpaperPath(backgroundPath)
      if (inspected.ok && inspected.path) allowedWallpaperPaths.add(path.resolve(inspected.path))
    }
  } catch {
    // A missing or invalid settings file is handled by the normal defaults.
  }

  protocol.handle('wallpaper', async request => {
    const filePath = decodeWallpaperResourceUrl(request.url)
    if (!filePath) return new Response('Wallpaper resource unavailable', { status: 404 })
    const normalizedPath = path.resolve(filePath)
    if (!allowedWallpaperPaths.has(normalizedPath)) {
      return new Response('Wallpaper resource unavailable', { status: 404 })
    }
    const inspected = inspectWallpaperPath(normalizedPath)
    if (!inspected.ok || inspected.type === undefined || inspected.path !== normalizedPath) {
      return new Response('Wallpaper resource unavailable', { status: 404 })
    }
    try {
      return await net.fetch(pathToFileURL(inspected.path).toString())
    } catch {
      return new Response('Wallpaper resource unavailable', { status: 404 })
    }
  })
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
