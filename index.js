/**
 * DSH restart — host half.
 *
 * Serves `/api/dsh-restart/status` and `/api/dsh-restart/restart`, decides which
 * kind of DSH is running (the desktop app, or `dsh web` under Node), and hands
 * the actual restart over to a detached helper process (`restart.mjs`) so that
 * the process tree being replaced cannot kill its own replacement.
 *
 * Why a helper process at all
 * ---------------------------
 * In the desktop app this module runs inside the Electron *Host* child of the
 * application. Killing it makes the Electron main process show its "Host
 * crashed" recovery dialog, so a restart has to be: quit the whole app through
 * its normal quit flow, wait until it is really gone, then launch it again.
 * Steps 2 and 3 must be performed by a process that outlives the app.
 *
 * The relaunch must not inherit this process's environment either: the Host runs
 * with `ELECTRON_RUN_AS_NODE=1`, and macOS LaunchServices passes the caller's
 * environment to the app it starts — a plain `open -a` therefore relaunched DSH
 * in Node mode, where it exited within ~100ms without opening a window.
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { platform as osPlatform, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const inject = ['webServer']

export const PLUGIN_NAME = '@local/dsh-restart'
const ROUTE_PREFIX = '/api/dsh-restart'
const DEFAULT_APP_ID = 'com.deepseek.dsh'
const DEFAULT_DELAY_MS = 900
const MIN_DELAY_MS = 200
const MAX_DELAY_MS = 10_000
const MAX_BODY_BYTES = 16 * 1024
const RESTART_GUARD_MS = 90_000
const HELPER_START_TIMEOUT_MS = 1_200

const DESKTOP_HOST_ENTRY = /[\\/]@deepseek-ai[\\/]dsh-desktop-host[\\/]lib[\\/](?:index|main)\.(?:js|mjs|cjs)$/
const DSH_PACKAGE_ENTRY = /[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/][^\\/]+\.(?:js|mjs|cjs)$/
const CLI_ENTRY = /(?:^|[\\/])(?:cli|main|startup|bin|dsh|web)\.(?:js|mjs|cjs)$/

const HELPER_SOURCE = fileURLToPath(new URL('./restart.mjs', import.meta.url))
const HELPER_DIRECTORY = join(tmpdir(), 'dsh-restart')

/* ---------------------------------------------------------------- detection */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0'])

export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost'
}

export function entryFromArgv(argv) {
  for (const argument of argv.slice(1)) {
    if (typeof argument !== 'string' || argument === '') continue
    if (argument.startsWith('-') || /^\d+$/.test(argument)) continue
    return argument
  }
  return undefined
}

function stripContentsMacOS(execPath) {
  const match = /^(.*?)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  return match === null ? undefined : match[1]
}

export function readPlistString(appPath, key) {
  try {
    const text = readFileSync(join(appPath, 'Contents', 'Info.plist'), 'utf8')
    const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(text)
    return match === null ? undefined : match[1]
  } catch {
    return undefined
  }
}

/**
 * Which DSH flavour is this process part of?
 *
 * Returns a target description, or a description with `mode: undefined` plus a
 * `reason` in `diagnostics` when this process cannot restart itself from here.
 */
export function detectTarget(options = {}) {
  const env = options.env ?? process.env
  const argv = options.argv ?? process.argv
  const pid = options.pid ?? process.pid
  const ppid = options.ppid ?? process.ppid
  const platform = options.platform ?? osPlatform()
  const execPath = options.execPath ?? process.execPath

  const forced = typeof env.DSH_RESTART_MODE === 'string' ? env.DSH_RESTART_MODE.trim() : ''
  if (forced === 'off') {
    return { mode: undefined, platform, diagnostics: { platform, forcedMode: 'off', reason: 'disabled-by-mode' } }
  }

  const entry = entryFromArgv(argv) ?? argv[1]
  const entryText = typeof entry === 'string' ? entry : ''
  const diagnostics = {
    platform,
    entry: entry ?? null,
    electronNode: env.ELECTRON_RUN_AS_NODE === '1',
    forcedMode: forced || null,
    pid,
    ppid,
  }

  // Only the two platforms this plugin is built and verified for. Everything
  // else reports unsupported-platform instead of guessing at a launch strategy.
  if (platform !== 'darwin' && platform !== 'win32') {
    return { mode: undefined, platform, diagnostics: { ...diagnostics, reason: 'unsupported-platform' } }
  }

  const desktop =
    forced === 'desktop' ||
    (forced === '' && env.ELECTRON_RUN_AS_NODE === '1' && DESKTOP_HOST_ENTRY.test(entryText) && ppid > 1)

  if (desktop) {
    let appPath
    let mainBinary
    let appId
    if (platform === 'darwin') {
      appPath = stripContentsMacOS(execPath)
      if (appPath === undefined) {
        const marker = entryText.indexOf('/Contents/Resources/')
        if (marker > 0) appPath = entryText.slice(0, marker)
      }
      mainBinary = execPath
      appId = appPath === undefined ? undefined : readPlistString(appPath, 'CFBundleIdentifier') ?? DEFAULT_APP_ID
    } else {
      appPath = execPath
      mainBinary = execPath
      appId = undefined
    }
    if (appPath === undefined || appPath === '') {
      return { mode: undefined, platform, diagnostics: { ...diagnostics, reason: 'app-bundle-not-found' } }
    }
    return {
      mode: 'desktop',
      platform,
      appPath,
      appId,
      mainBinary,
      mainPid: ppid,
      hostPid: pid,
      launchEnvironment: platform === 'darwin' ? 'minimal (LaunchServices, clean env)' : 'clean (no ELECTRON_RUN_AS_NODE)',
      diagnostics,
    }
  }

  const cli = DSH_PACKAGE_ENTRY.test(entryText) || (CLI_ENTRY.test(entryText) && entryText.includes('dsh'))
  if (forced === 'cli' || (forced === '' && cli && ppid > 1)) {
    return {
      mode: 'cli',
      platform,
      appPath: execPath,
      appId: undefined,
      mainBinary: undefined,
      mainPid: null,
      hostPid: pid,
      args: argv.slice(1),
      launchEnvironment: 'inherited (node / electron-as-node)',
      diagnostics,
    }
  }

  return { mode: undefined, platform, diagnostics: { ...diagnostics, reason: 'not-a-dsh-carrier' } }
}

export function nodeModeVariables(env) {
  const found = []
  for (const name of [
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
    'NODE_REPL_EXTERNAL_MODULE',
    'DSH_DESKTOP_NODE_EXECUTABLE',
  ]) {
    if (typeof env[name] === 'string' && env[name] !== '') found.push(name)
  }
  return found
}

export function describeTarget(target) {
  return {
    supported: target.mode !== undefined,
    mode: target.mode ?? null,
    platform: target.platform,
    reason: target.diagnostics?.reason ?? null,
    appPath: target.appPath ?? null,
    appId: target.appId ?? null,
    mainBinary: target.mainBinary ?? null,
    mainPid: target.mainPid ?? null,
    hostPid: target.hostPid ?? null,
    launchEnvironment: target.launchEnvironment ?? null,
    inheritedNodeMode: nodeModeVariables(process.env),
    diagnostics: target.diagnostics ?? null,
  }
}

/* -------------------------------------------------------------------- http */

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

function ok(res, value) {
  sendJson(res, 200, { ok: true, value })
}

function fail(res, status, code, message, extra = {}) {
  sendJson(res, status, { ok: false, error: { code, message }, ...extra })
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('invalid-body'))
          return
        }
        resolve(parsed)
      } catch {
        reject(new Error('invalid-body'))
      }
    })
    req.on('error', reject)
  })
}

function ownOrigins(webServer) {
  const origins = new Set(['dsh-app://app'])
  try {
    const origin = webServer.getOrigin()
    if (typeof origin === 'string' && origin !== '') origins.add(origin)
  } catch {}
  return origins
}

export function isTrustedRequest(req, webServer) {
  const address = req.socket?.remoteAddress
  if (!isLoopbackAddress(address)) return false
  const host = req.headers?.host
  if (typeof host === 'string' && host !== '') {
    let hostname = host
    const bracket = /^\[([^\]]+)\]/.exec(host)
    if (bracket !== null) hostname = bracket[1]
    else hostname = host.split(':')[0]
    if (!LOOPBACK_HOSTS.has(`${hostname}`.toLowerCase())) return false
  }
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    return ownOrigins(webServer).has(origin)
  }
  return true
}

/* ------------------------------------------------------------------ helper */

function clampDelay(value) {
  if (!Number.isFinite(value)) return DEFAULT_DELAY_MS
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(value)))
}

function ensureHelperScript() {
  if (!existsSync(HELPER_SOURCE)) throw new Error(`helper script missing: ${HELPER_SOURCE}`)
  mkdirSync(HELPER_DIRECTORY, { recursive: true })
  const destination = join(HELPER_DIRECTORY, 'restart.mjs')
  copyFileSync(HELPER_SOURCE, destination)
  return destination
}

export function buildTargetFile(target, settings) {
  return {
    mode: target.mode,
    hostPid: target.hostPid,
    mainPid: target.mainPid ?? null,
    appPath: target.appPath,
    appId: target.appId ?? null,
    mainBinary: target.mainBinary ?? null,
    args: target.args ?? [],
    logPath: settings.logPath,
    delayMs: settings.delayMs,
    dryRun: settings.dryRun === true,
  }
}

function writeTargetFile(target, settings) {
  mkdirSync(HELPER_DIRECTORY, { recursive: true })
  const path = join(HELPER_DIRECTORY, `target-${process.pid}-${Date.now()}.json`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(buildTargetFile(target, settings)))
  return path
}

async function spawnHelper(scriptPath, targetPath, logPath) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  const child = spawn(process.execPath, [scriptPath, targetPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  })
  const pid = await new Promise((resolve, reject) => {
    child.once('spawn', () => resolve(child.pid))
    child.once('error', reject)
  })
  child.unref()
  // The helper writes its first log line straight away. If it dies without
  // writing one, the bridge must report a failure instead of leaving the button
  // stuck on "waiting" until the UI times out.
  const deadline = Date.now() + HELPER_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (existsSync(logPath)) return { pid, started: true }
    if (child.exitCode !== null || child.signalCode !== null) break
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  return { pid, started: existsSync(logPath) }
}

/* -------------------------------------------------------------------- apply */

export function apply(ctx, config) {
  const logger = typeof ctx?.logger === 'function' ? ctx.logger(PLUGIN_NAME) : undefined
  const log = (level, ...rest) => {
    if (logger !== undefined && typeof logger[level] === 'function') logger[level](...rest)
  }
  const webServer = ctx.webServer
  const state = { restarting: false, lastRequest: null, guardTimer: undefined }

  const settings = (override = {}) => {
    const dryRun = override.dryRun === true || config?.dryRun === true || process.env.DSH_RESTART_DRY_RUN === '1'
    const delayMs = clampDelay(override.delayMs ?? config?.delayMs)
    return {
      dryRun,
      delayMs,
      logPath: join(HELPER_DIRECTORY, `restart-${Date.now()}.log`),
    }
  }

  const statusValue = (override) => {
    const target = detectTarget()
    const resolved = settings(override)
    return {
      ...describeTarget(target),
      delayMs: resolved.delayMs,
      dryRun: resolved.dryRun,
      restarting: state.restarting,
      lastRequest: state.lastRequest,
      logDirectory: HELPER_DIRECTORY,
    }
  }

  const restart = async (override) => {
    if (state.restarting) {
      return { status: 202, body: { ok: true, value: { alreadyRequested: true, restarting: true } } }
    }
    const target = detectTarget()
    const resolved = settings(override)
    if (target.mode === undefined) {
      return {
        status: 409,
        body: {
          ok: false,
          error: { code: 'restart/unsupported', message: 'This DSH process cannot restart itself from here.' },
          diagnostics: target.diagnostics,
        },
      }
    }
    if (resolved.dryRun) {
      return {
        status: 200,
        body: {
          ok: true,
          value: {
            accepted: false,
            dryRun: true,
            plan: buildTargetFile(target, resolved),
          },
        },
      }
    }
    try {
      const scriptPath = ensureHelperScript()
      const targetPath = writeTargetFile(target, resolved)
      const started = await spawnHelper(scriptPath, targetPath, resolved.logPath)
      if (!started.started) {
        try {
          unlinkSync(targetPath)
        } catch {}
        log('error', 'restart helper exited before it started', {
          helperPid: started.pid,
          logPath: resolved.logPath,
        })
        return {
          status: 500,
          body: {
            ok: false,
            error: {
              code: 'restart/helper-exited',
              message: `The restart helper exited without starting (no log at ${resolved.logPath}).`,
            },
          },
        }
      }
      const helperPid = started.pid
      state.restarting = true
      state.lastRequest = {
        at: new Date().toISOString(),
        mode: target.mode,
        helperPid,
        logPath: resolved.logPath,
      }
      clearTimeout(state.guardTimer)
      state.guardTimer = setTimeout(() => {
        state.restarting = false
      }, RESTART_GUARD_MS)
      state.guardTimer.unref?.()
      log('info', 'restart helper started', {
        helperPid,
        mode: target.mode,
        logPath: resolved.logPath,
      })
      return {
        status: 202,
        body: {
          ok: true,
          value: { accepted: true, mode: target.mode, helperPid, logPath: resolved.logPath },
        },
      }
    } catch (error) {
      state.restarting = false
      log('error', 'restart helper could not be started', error)
      return {
        status: 500,
        body: {
          ok: false,
          error: { code: 'restart/spawn-failed', message: String(error?.message ?? error) },
        },
      }
    }
  }

  const guard = (handler, { mutating }) => async (req, res) => {
    if (!isTrustedRequest(req, webServer)) {
      fail(res, 403, 'bridge/forbidden', 'Only local requests from this DSH instance are allowed.')
      return
    }
    if (mutating && req.method !== 'POST') {
      fail(res, 405, 'bridge/method-not-allowed', 'Use POST for this endpoint.')
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      const message = error?.message
      const status = message === 'invalid-body' ? 400 : message === 'body-too-large' ? 413 : 500
      const code =
        status === 400 ? 'bridge/invalid-body' : status === 413 ? 'bridge/body-too-large' : 'bridge/failed'
      fail(res, status, code, 'The restart bridge could not handle this request.')
      log('warn', 'bridge request failed', error)
    }
  }

  return ctx.effect(() => {
    const disposers = []
    disposers.push(
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/status`,
        handler: guard(async (_req, res) => {
          ok(res, statusValue())
        }, { mutating: false }),
      }),
    )
    disposers.push(
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/restart`,
        handler: guard(
          async (req, res) => {
            let body = {}
            if (req.method === 'POST') {
              try {
                body = await readJsonBody(req)
              } catch (error) {
                if (error?.message === 'invalid-body' || error?.message === 'body-too-large') throw error
                body = {}
              }
            }
            const result = await restart(body)
            sendJson(res, result.status, result.body)
          },
          { mutating: true },
        ),
      }),
    )
    return () => {
      clearTimeout(state.guardTimer)
      for (const dispose of [...disposers].reverse()) dispose()
    }
  }, 'dsh-restart: bridge routes')
}
