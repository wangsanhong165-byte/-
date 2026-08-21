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
  assert.match(modeSwitch, /replacement\.loadURL\(appUrl\)/)
  assert.match(modeSwitch, /oldWindow\.destroy\(\)/)
  assert.match(modeSwitch, /petMode = !targetPetMode/)
})

test('pet mode uses a full-work-area window with passthrough controls', () => {
  assert.match(MAIN_SOURCE, /replacement\.setSkipTaskbar\(true\)/)
  assert.match(MAIN_SOURCE, /replacement\.setIgnoreMouseEvents\(true, \{ forward: true \}\)/)
  assert.match(MAIN_SOURCE, /ipcMain\.on\('pet:setMousePassthrough'/)
})
