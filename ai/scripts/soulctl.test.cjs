const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  computeBuildFingerprint,
  readRuntimeConfig,
  selectPython,
  npmInvocation,
  controlTimeoutFor,
  serviceUrlFromLifecycleOutput,
} = require('./soulctl.cjs')

test('runtime config supports default and per-service Python', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soullink-config-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'config'))
  fs.writeFileSync(path.join(root, 'config', 'runtime.local.json'), JSON.stringify({
    python: { default: 'runtime-python', services: { asr: 'asr-python' } },
  }))
  const config = readRuntimeConfig(root)
  assert.equal(config.python.default, 'runtime-python')
  assert.equal(config.python.services.asr, 'asr-python')
})

test('explicit Python has priority over local configuration', () => {
  const selected = selectPython({
    cliPython: 'cli-python',
    config: { python: { default: 'config-python' } },
    environment: { MAIN_PYTHON: 'env-python' },
    exists: () => true,
    which: () => 'path-python',
  })
  assert.equal(selected, 'cli-python')
})

test('build fingerprint changes when a tracked input changes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soullink-build-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const frontend = path.join(root, 'frontend')
  fs.mkdirSync(path.join(frontend, 'src'), { recursive: true })
  fs.writeFileSync(path.join(frontend, 'src', 'main.tsx'), 'one')
  fs.writeFileSync(path.join(frontend, 'package.json'), '{}')
  const first = computeBuildFingerprint(frontend, 'v20.0.0')
  fs.writeFileSync(path.join(frontend, 'src', 'main.tsx'), 'two')
  const second = computeBuildFingerprint(frontend, 'v20.0.0')
  assert.notEqual(first.sourceHash, second.sourceHash)
})

test('Windows npm commands use ComSpec instead of spawning npm.cmd directly', () => {
  const invocation = npmInvocation(['run', 'build'])
  if (process.platform === 'win32') {
    assert.match(invocation.command.toLowerCase(), /cmd\.exe$/)
    assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c'])
  }
})

test('lifecycle control commands always have bounded timeouts', () => {
  assert.equal(controlTimeoutFor('status'), 5_000)
  assert.equal(controlTimeoutFor('stop'), 60_000)
  assert.equal(controlTimeoutFor('shutdown'), 60_000)
  assert.equal(controlTimeoutFor('start'), 480_000)
})

test('web launch prints the Bridge endpoint resolved by the lifecycle supervisor', () => {
  const stdout = JSON.stringify({
    ok: true,
    result: {
      services: [{ id: 'bridge', host: '127.0.0.1', port: 19306 }],
    },
  })

  assert.equal(
    serviceUrlFromLifecycleOutput(stdout, 'bridge'),
    'http://127.0.0.1:19306',
  )
})
