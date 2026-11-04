// Host-half tests for @local/dsh-restart: routing, request trust, target
// detection and the helper task file. No process is restarted here (dryRun and
// the 409 path keep the helper out of the picture); the restart state machine
// itself is covered by restart.test.mjs and helper.test.mjs.
import { EventEmitter } from 'node:events'
import assert from 'node:assert'

const plugin = await import(new URL('../index.js', import.meta.url).href)

const routes = []
const webServer = {
  getOrigin: () => 'http://127.0.0.1:53556',
  register: (route) => {
    routes.push(route)
    return () => {}
  },
}

const origin = 'http://127.0.0.1:53556'
const ctx = {
  webServer,
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  effect: (fn) => fn(),
}

plugin.apply(ctx)
assert.deepEqual(plugin.inject, ['webServer'])
assert.equal(routes.length, 2)
assert.deepEqual(
  routes.map((route) => `${route.kind} ${route.path}`),
  ['exact /api/dsh-restart/status', 'exact /api/dsh-restart/restart'],
)
console.log('ok: bridge routes registered')

const byPath = (path) => routes.find((route) => route.path === path).handler

function makeReq({ method = 'GET', headers = {}, body = null, address = '127.0.0.1' }) {
  const req = new EventEmitter()
  req.method = method
  req.headers = { host: '127.0.0.1:53556', ...headers }
  req.socket = { remoteAddress: address }
  req.destroy = () => {}
  queueMicrotask(() => {
    if (body !== null) req.emit('data', Buffer.from(body, 'utf8'))
    req.emit('end')
  })
  return req
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers
    },
    end(chunk) {
      if (typeof chunk === 'string') res.body += chunk
      else if (chunk !== undefined) res.body += Buffer.from(chunk).toString('utf8')
      res.done?.()
    },
  }
  res.json = () => JSON.parse(res.body)
  return res
}

async function call(path, requestOptions) {
  const res = makeRes()
  const pending = byPath(path)(makeReq(requestOptions), res)
  if (pending !== undefined) await pending
  for (let round = 0; round < 20 && res.statusCode === 0; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return res
}

// ---- detection ------------------------------------------------------------

function detect(options) {
  return plugin.detectTarget({
    env: {},
    argv: ['node', '/tmp/host.test.mjs'],
    pid: 4242,
    ppid: 4000,
    platform: 'darwin',
    execPath: '/usr/local/bin/node',
    ...options,
  })
}

const plain = detect()
assert.equal(plain.mode, undefined)
assert.equal(plain.diagnostics.reason, 'not-a-dsh-carrier')
console.log('ok: plain node process is not a restartable carrier')

const desktop = detect({
  env: { ELECTRON_RUN_AS_NODE: '1' },
  argv: [
    '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
    '--expose-internals',
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js',
  ],
  execPath: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
})
assert.equal(desktop.mode, 'desktop')
assert.equal(desktop.appPath, '/Applications/DeepSeek Harness.app')
assert.equal(desktop.mainBinary, '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness')
assert.equal(desktop.mainPid, 4000)
assert.equal(desktop.hostPid, 4242)
assert.equal(desktop.appId, 'com.deepseek.dsh', `expected bundle id from Info.plist, got ${desktop.appId}`)
console.log('ok: macOS desktop host detected:', desktop.appPath, desktop.appId)

const windowsDesktop = detect({
  env: { ELECTRON_RUN_AS_NODE: '1' },
  platform: 'win32',
  argv: [
    'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    '--expose-internals',
    'C:\\Program Files\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js',
  ],
  execPath: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
})
assert.equal(windowsDesktop.mode, 'desktop')
assert.equal(windowsDesktop.appPath, 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe')
assert.equal(windowsDesktop.mainPid, 4000)
console.log('ok: Windows desktop host detected:', windowsDesktop.appPath)

const cli = detect({
  argv: ['node', '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/cli.js', 'web', '--port', '3080'],
  execPath: '/usr/local/bin/node',
})
assert.equal(cli.mode, 'cli')
assert.deepEqual(cli.args, ['/opt/dsh/node_modules/@deepseek-ai/dsh/lib/cli.js', 'web', '--port', '3080'])
console.log('ok: dsh cli carrier detected')

const unsupported = detect({ platform: 'linux' })
assert.equal(unsupported.mode, undefined)
assert.equal(unsupported.diagnostics.reason, 'unsupported-platform')
console.log('ok: platforms other than macOS/Windows are refused')

const off = detect({ env: { DSH_RESTART_MODE: 'off' } })
assert.equal(off.mode, undefined)
assert.equal(off.diagnostics.reason, 'disabled-by-mode')
console.log('ok: DSH_RESTART_MODE=off disables the bridge')

assert.equal(plugin.isLoopbackAddress('127.0.0.1'), true)
assert.equal(plugin.isLoopbackAddress('::1'), true)
assert.equal(plugin.isLoopbackAddress('::ffff:127.0.0.1'), true)
assert.equal(plugin.isLoopbackAddress('10.0.0.7'), false)
console.log('ok: loopback address detection')

// ---- status route ---------------------------------------------------------

let res = await call('/api/dsh-restart/status', { method: 'GET' })
assert.equal(res.statusCode, 200)
let body = res.json()
assert.equal(body.ok, true)
assert.equal(body.value.supported, false, 'the test process is not a restartable carrier')
assert.equal(body.value.reason, 'not-a-dsh-carrier')
assert.ok(Array.isArray(body.value.inheritedNodeMode))
assert.equal(typeof body.value.delayMs, 'number')
assert.equal(typeof body.value.logDirectory, 'string')
console.log('ok: status reports the plain-node diagnostics')

res = await call('/api/dsh-restart/status', { method: 'POST', body: '{}' })
assert.equal(res.statusCode, 200)
console.log('ok: status accepts POST too')

// ---- trust ----------------------------------------------------------------

res = await call('/api/dsh-restart/status', { method: 'GET', address: '192.168.1.20' })
assert.equal(res.statusCode, 403)
assert.equal(res.json().error.code, 'bridge/forbidden')
console.log('ok: non-loopback peer is rejected')

res = await call('/api/dsh-restart/status', { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } })
assert.equal(res.statusCode, 403)
console.log('ok: cross-site fetch is rejected')

res = await call('/api/dsh-restart/status', { method: 'GET', headers: { origin: 'https://evil.example' } })
assert.equal(res.statusCode, 403)
console.log('ok: foreign Origin is rejected')

res = await call('/api/dsh-restart/status', { method: 'GET', headers: { origin: 'dsh-app://app' } })
assert.equal(res.statusCode, 200)
console.log('ok: desktop app Origin (dsh-app://app) is trusted')

res = await call('/api/dsh-restart/status', { method: 'GET', headers: { origin } })
assert.equal(res.statusCode, 200)
console.log('ok: same-origin request is trusted')

// ---- restart route --------------------------------------------------------

res = await call('/api/dsh-restart/restart', { method: 'GET' })
assert.equal(res.statusCode, 405)
assert.equal(res.json().error.code, 'bridge/method-not-allowed')
console.log('ok: GET restart is method-not-allowed')

res = await call('/api/dsh-restart/restart', { method: 'POST', body: '{not json' })
assert.equal(res.statusCode, 400)
assert.equal(res.json().error.code, 'bridge/invalid-body')
console.log('ok: malformed JSON body is rejected')

res = await call('/api/dsh-restart/restart', { method: 'POST', body: '{}' })
assert.equal(res.statusCode, 409)
assert.equal(res.json().error.code, 'restart/unsupported')
assert.ok(res.json().diagnostics, 'unsupported must carry diagnostics')
console.log('ok: restart refuses a non-carrier with diagnostics')

// ---- helper task file -----------------------------------------------------

const plan = plugin.buildTargetFile(
  {
    mode: 'desktop',
    hostPid: 4242,
    mainPid: 4000,
    appPath: '/Applications/DeepSeek Harness.app',
    appId: 'com.deepseek.dsh',
    mainBinary: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
    args: [],
  },
  { logPath: '/tmp/dsh-restart/restart-1.log', delayMs: 900, dryRun: true },
)
assert.deepEqual(plan, {
  mode: 'desktop',
  hostPid: 4242,
  mainPid: 4000,
  appPath: '/Applications/DeepSeek Harness.app',
  appId: 'com.deepseek.dsh',
  mainBinary: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
  args: [],
  logPath: '/tmp/dsh-restart/restart-1.log',
  delayMs: 900,
  dryRun: true,
})
assert.deepEqual(plugin.nodeModeVariables({ ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x' }), [
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
])
console.log('ok: helper task file shape and node-mode diagnostics')

console.log('\nALL HOST TESTS PASSED')
