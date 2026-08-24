const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const MAIN_SOURCE = fs.readFileSync(
  path.join(__dirname, 'main.cjs'),
  'utf8',
)
const DEVELOPER_WORKSPACE_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'ui', 'DeveloperWorkspace.tsx'),
  'utf8',
)
const PET_SURFACES_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'ui', 'PetSurfaces.tsx'),
  'utf8',
)

function sourceBetween (start, end) {
  const afterStart = MAIN_SOURCE.split(start, 2)[1]
  assert.ok(afterStart, `missing source marker: ${start}`)
  return afterStart.split(end, 1)[0]
}

test('main UI transition stops startup lifecycle polling only after a successful load', () => {
  const loadAppUrl = sourceBetween(
    'async function loadAppUrl() {',
    '// ── System tray',
  )

  assert.match(loadAppUrl, /if \(mainUiLoaded \|\| mainUiLoading/)
  assert.match(loadAppUrl, /return mainWindow\.loadURL\(appUrl\)\.then/)
  assert.match(loadAppUrl, /clearInterval\(statusTimer\)/)
  assert.match(loadAppUrl, /statusTimer = null/)
  assert.ok(
    loadAppUrl.indexOf('return mainWindow.loadURL(appUrl)')
      < loadAppUrl.indexOf('clearInterval(statusTimer)'),
    'startup polling must remain active until the main UI actually loads',
  )
  assert.match(loadAppUrl, /setTimeout\(\(\) =>/)
  assert.match(loadAppUrl, /loadAppUrl\(\)/)
})

test('startup refresh is bounded and stable runtime refresh remains on demand', () => {
  const pollingLoop = sourceBetween(
    'statusTimer = setInterval',
    '// Now show the window',
  )
  const statusHandler = sourceBetween(
    "ipcMain.handle('get-status'",
    "ipcMain.handle('lifecycle:getSnapshot'",
  )

  // This timer exists only while the bootstrap page is visible; loadAppUrl()
  // clears it in the preceding regression test.  Startup may refresh the
  // cached snapshot, but must not bypass ProcessManager rate limiting.
  assert.match(pollingLoop, /pm\.refresh\(\)/)
  assert.doesNotMatch(pollingLoop, /pm\.refresh\(true\)/)
  assert.match(statusHandler, /pm\.refresh\(\)/)
})

test('startup uses the shared text-ready policy while voice services continue', () => {
  const pollingLoop = sourceBetween(
    'statusTimer = setInterval',
    '// Now show the window',
  )
  const startupGate = sourceBetween(
    'startPromise.then(status => {',
    '  }).catch',
  )

  assert.match(MAIN_SOURCE, /require\('\.\/startup-policy\.cjs'\)/)
  assert.match(pollingLoop, /beginCompanionLoad\(status\)/)
  assert.match(startupGate, /beginCompanionLoad\(status\)/)
  assert.doesNotMatch(startupGate, /availability === 'FULL_READY'/)
})

test('renderer console capture never blocks the Electron main process', () => {
  const consoleHandler = sourceBetween(
    "window.webContents.on('console-message'",
    '// Close',
  )

  assert.doesNotMatch(consoleHandler, /appendFileSync/)
  assert.match(consoleHandler, /fs\.appendFile\(/)
  assert.match(consoleHandler, /!isDev && level < 2/)
})

test('developer diagnostics refresh only on demand and handle failures', () => {
  const handledRequests = (
    DEVELOPER_WORKSPACE_SOURCE.match(/\.catch\(recordRequestError\)/g) ?? []
  ).length

  assert.doesNotMatch(DEVELOPER_WORKSPACE_SOURCE, /window\.setInterval/)
  assert.match(DEVELOPER_WORKSPACE_SOURCE, /if \(!connected\) return/)
  assert.ok(handledRequests >= 3)
})

test('explicit application quit shuts down every registered workspace service', () => {
  const beforeQuit = sourceBetween(
    "app.on('before-quit'",
    '\n})',
  )

  assert.match(beforeQuit, /await pm\.shutdownAll\(\)/)
})

test('closing the main window quits the application instead of leaving a tray process', () => {
  const closeHandler = sourceBetween(
    "window.on('close'",
    "window.on('closed'",
  )

  assert.doesNotMatch(closeHandler, /event\.preventDefault\(\)/)
  assert.doesNotMatch(closeHandler, /mainWindow\.hide\(\)/)
  assert.match(closeHandler, /forceQuit = true/)
  assert.match(closeHandler, /app\.quit\(\)/)
})

test('Electron is single-instance so repeated script clicks cannot race startup', () => {
  assert.match(MAIN_SOURCE, /app\.requestSingleInstanceLock\(\)/)
  assert.match(MAIN_SOURCE, /app\.on\('second-instance'/)
  assert.match(MAIN_SOURCE, /mainWindow\.focus\(\)/)
})

test('bootstrap reads the lifecycle service status field returned by Python', () => {
  const bootstrap = fs.readFileSync(
    path.join(__dirname, 'bootstrap', 'bootstrap.js'),
    'utf8',
  )
  assert.match(bootstrap, /svc\.status \|\| svc\.state/)
  assert.match(bootstrap, /serviceStatus\(s\) === 'failed'/)
})

test('normal stage is opaque while pet mode recreates a transparent window', () => {
  const createWindow = sourceBetween(
    'function createWindow(',
    'async function loadAppUrl()',
  )
  const modeSwitch = sourceBetween(
    'async function recreateWindowForMode(',
    '// ── System tray',
  )

  assert.match(createWindow, /transparent = false/)
  assert.match(createWindow, /transparent,/)
  assert.match(createWindow, /backgroundColor: transparent \? '#00000000' : '#1a2030'/)
  assert.match(createWindow, /backgroundThrottling: false/)
  assert.match(modeSwitch, /transparent: targetPetMode/)
  assert.match(modeSwitch, /replacement\.loadURL\(targetPetMode \? withSurfaceQuery\(appUrl, 'pet-model'\) : appUrl\)/)
  assert.match(modeSwitch, /conversation\?\.loadURL\(withSurfaceQuery\(appUrl, 'pet-conversation'\)\)/)
  assert.match(modeSwitch, /oldWindow\.destroy\(\)/)
  assert.match(modeSwitch, /petMode = !targetPetMode/)
})

test('pet mode uses compact native surfaces without a display-sized passthrough overlay', () => {
  const configurePetSurface = sourceBetween(
    'function configurePetSurface(',
    'async function recreateWindowForMode(',
  )

  assert.match(configurePetSurface, /window\.setSkipTaskbar\(true\)/)
  assert.match(configurePetSurface, /window\.setAlwaysOnTop\(true\)/)
  assert.match(MAIN_SOURCE, /getPetConversationBounds\(display\.workArea\)/)
  assert.doesNotMatch(MAIN_SOURCE, /setIgnoreMouseEvents/)
  assert.doesNotMatch(MAIN_SOURCE, /pet:setMousePassthrough/)
})

test('window mode IPC waits for the replacement window and reports failures', () => {
  const modeSwitch = sourceBetween(
    "ipcMain.handle('window:setPetMode'",
    "ipcMain.on('pet:publishSnapshot'",
  )
  const recreate = sourceBetween(
    'async function recreateWindowForMode(',
    'async function loadAppUrl()',
  )

  assert.match(MAIN_SOURCE, /ipcMain\.handle\('window:setPetMode', async/)
  assert.match(modeSwitch, /await recreateWindowForMode\(true, petBounds\)/)
  assert.match(modeSwitch, /await recreateWindowForMode\(false, normalBounds\)/)
  assert.match(recreate, /throw error/)
})

test('visible windows keep full-rate rendering while hidden or minimized windows may throttle', () => {
  const createWindow = sourceBetween(
    'function createWindow(',
    'async function recreateWindowForMode(',
  )

  assert.match(createWindow, /window\.on\('minimize'.*setBackgroundThrottling\(true\)/s)
  assert.match(createWindow, /window\.on\('hide'.*setBackgroundThrottling\(true\)/s)
  assert.match(createWindow, /window\.on\('restore'.*setBackgroundThrottling\(false\)/s)
  assert.match(createWindow, /window\.on\('show'.*setBackgroundThrottling\(false\)/s)
  const blurHandler = createWindow.split("window.on('blur'", 2)[1]?.split('\n', 2)[0] ?? ''
  assert.doesNotMatch(blurHandler, /setBackgroundThrottling/)
})

test('Electron exposes measured display and GPU diagnostics instead of assuming a frame cap', () => {
  assert.match(MAIN_SOURCE, /SOULLINK_FORCE_HIGH_PERFORMANCE_GPU/)
  assert.match(MAIN_SOURCE, /appendSwitch\('force_high_performance_gpu'\)/)
  assert.match(MAIN_SOURCE, /ipcMain\.handle\('performance:getElectronDiagnostics'/)
  assert.match(MAIN_SOURCE, /app\.getGPUInfo\('complete'\)/)
  assert.match(MAIN_SOURCE, /app\.getGPUFeatureStatus\(\)/)
  assert.match(MAIN_SOURCE, /displayFrequency/)
  assert.match(MAIN_SOURCE, /getBackgroundThrottling\(\)/)
})

test('pet mode uses independent compact model and conversation renderer surfaces', () => {
  assert.match(MAIN_SOURCE, /getPetConversationBounds/)
  assert.match(MAIN_SOURCE, /petConversationWindow/)
  assert.match(MAIN_SOURCE, /withSurfaceQuery\(appUrl, 'pet-model'\)/)
  assert.match(MAIN_SOURCE, /withSurfaceQuery\(appUrl, 'pet-conversation'\)/)
  assert.match(MAIN_SOURCE, /pet:publishSnapshot/)
  assert.match(MAIN_SOURCE, /pet:command/)
  assert.doesNotMatch(MAIN_SOURCE, /getPetBounds\(display\.workArea\).*setIgnoreMouseEvents\(true/s)
})

test('pet mode starts model-only and tray owns conversation and stage navigation', () => {
  const traySource = sourceBetween(
    '// ── System tray',
    '// ── IPC handlers (window controls)',
  )
  const visibilityHandler = sourceBetween(
    "ipcMain.on('pet:setConversationVisible'",
    "ipcMain.on('pet:resizeModel'",
  )
  const modeSwitch = sourceBetween(
    "ipcMain.handle('window:setPetMode'",
    "ipcMain.on('pet:publishSnapshot'",
  )

  assert.match(MAIN_SOURCE, /let petConversationVisible = false/)
  assert.match(modeSwitch, /petConversationVisible = false/)
  assert.match(traySource, /showCompanionWindows/)
  assert.match(traySource, /hideCompanionWindows/)
  assert.match(traySource, /petConversationVisible \? '隐藏对话' : '打开对话'/)
  assert.match(traySource, /label: '返回主界面'/)
  assert.match(traySource, /refreshTrayMenu/)
  assert.match(visibilityHandler, /petConversationVisible = Boolean\(visible\)/)
  assert.match(visibilityHandler, /refreshTrayMenu\(\)/)
})

test('pet model surface is visually model-only and compact conversation only hides itself', () => {
  const modelSurface = PET_SURFACES_SOURCE
    .split('export function PetModelSurface', 2)[1]
    .split('export function PetConversationSurface', 1)[0]
  const conversationSurface = PET_SURFACES_SOURCE
    .split('export function PetConversationSurface', 2)[1]

  assert.ok(modelSurface)
  assert.ok(conversationSurface)
  assert.match(modelSurface, /<CharacterView \/>/)
  assert.doesNotMatch(modelSurface, /pet-model-controls/)
  assert.doesNotMatch(modelSurface, /setPetConversationVisible/)
  assert.doesNotMatch(modelSurface, /onExit/)
  assert.match(conversationSurface, /setPetConversationVisible\(false\)/)
  assert.doesNotMatch(conversationSurface, /exit-pet/)
})

test('frameless dragging follows the sending compact window, not a global overlay', () => {
  const dragHandler = sourceBetween(
    "ipcMain.on('window:dragStart'",
    "ipcMain.on('window:dragEnd'",
  )

  assert.match(dragHandler, /BrowserWindow\.fromWebContents\(event\.sender\)/)
  assert.match(dragHandler, /dragWindow\.setBounds/)
  assert.doesNotMatch(dragHandler, /mainWindow\.setBounds/)
})
