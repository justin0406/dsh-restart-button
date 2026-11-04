/**
 * DSH restart helper.
 *
 * Runs in its own process (outside the DSH host) so that it survives the
 * process tree it has to replace.  It is started by the host half through
 * `node restart.mjs <target.json>`; everything it needs lives in that JSON
 * file, which is deleted again on the way out.
 *
 * Two modes are supported:
 *   - desktop : the DSH desktop app (Electron shell + bundled desktop host)
 *   - cli     : `dsh web ...` running under a plain Node / Electron-as-node
 */
import { realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { platform as osPlatform, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const PLATFORM = osPlatform()
export const IS_WINDOWS = PLATFORM === 'win32'
export const IS_MAC = PLATFORM === 'darwin'
/** Platforms this helper can drive; the host half refuses everything else. */
export const SUPPORTED_PLATFORMS = new Set(['darwin', 'win32'])

const numberFromEnv = (name, fallback) => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

export const DEFAULT_DELAY_MS = 900
/** How long a quit request may take before we conclude the user cancelled it. */
export const QUIT_WAIT_MS = numberFromEnv('DSH_RESTART_QUIT_WAIT_MS', 90_000)
/** How long the old app may take to fully disappear once its main process exited. */
export const SETTLE_MS = numberFromEnv('DSH_RESTART_SETTLE_MS', 6_000)
/** Quiet moment between teardown and the first launch. */
export const PAUSE_MS = numberFromEnv('DSH_RESTART_PAUSE_MS', 3_000)
/** A relaunched instance must stay alive this long before we call it a success. */
export const CONFIRM_MS = numberFromEnv('DSH_RESTART_CONFIRM_MS', 3_000)
/** How long to wait for a launched instance to appear at all. */
export const LAUNCH_WAIT_MS = numberFromEnv('DSH_RESTART_LAUNCH_WAIT_MS', 15_000)
export const LAUNCH_TRIES = numberFromEnv('DSH_RESTART_LAUNCH_TRIES', 4)
/** How long a process may take to exit after we ask it to. */
export const PROCESS_WAIT_MS = numberFromEnv('DSH_RESTART_PROCESS_WAIT_MS', 20_000)
export const POLL_MS = 120
const WINDOW_VISIBLE_TIMEOUT_MS = 90_000

/* ------------------------------------------------------------------ tables */

/** `ps -A -o pid= -o ppid= -o args=` stdout → Map<pid, { ppid, args }>. */
export function parsePosixProcessTable(text) {
  const table = new Map()
  for (const line of String(text).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line)
    if (match === null) continue
    table.set(Number(match[1]), { ppid: Number(match[2]), args: match[3] ?? '' })
  }
  return table
}

/** PowerShell `Get-CimInstance Win32_Process | ConvertTo-Json -Compress` → Map. */
export function parseWindowsProcessTable(text) {
  const table = new Map()
  const raw = String(text).trim()
  if (raw === '') return table
  let rows
  try {
    rows = JSON.parse(raw)
  } catch {
    return table
  }
  if (!Array.isArray(rows)) rows = [rows]
  for (const row of rows) {
    const pid = Number(row?.ProcessId)
    if (!Number.isInteger(pid) || pid <= 0) continue
    table.set(pid, {
      ppid: Number(row?.ParentProcessId ?? 0),
      args: typeof row?.CommandLine === 'string' ? row.CommandLine : '',
      executable: typeof row?.ExecutablePath === 'string' ? row.ExecutablePath : '',
    })
  }
  return table
}

export function runCapture(command, args, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      resolve(undefined)
      return
    }
    let out = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      finish(undefined)
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      out += chunk
      if (out.length > 4_000_000) out = out.slice(-2_000_000)
    })
    child.on('error', () => finish(undefined))
    child.on('close', (code) => finish(code === 0 ? out : undefined))
  })
}

export async function processTable(platform = PLATFORM) {
  if (platform === 'win32') {
    const text = await runCapture(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
      ],
    )
    return parseWindowsProcessTable(text ?? '')
  }
  const text = await runCapture('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'args='])
  return parsePosixProcessTable(text ?? '')
}

/** Children before parents, so that a tree can be signalled bottom-up. */
export function descendantOrder(table, rootPid, excludePid = process.pid) {
  const children = new Map()
  for (const [pid, row] of table) {
    const list = children.get(row.ppid)
    if (list === undefined) children.set(row.ppid, [pid])
    else list.push(pid)
  }
  const order = []
  const seen = new Set()
  const walk = (pid) => {
    if (seen.has(pid)) return
    seen.add(pid)
    const list = children.get(pid)
    if (list !== undefined) for (const child of list) walk(child)
    if (pid !== excludePid) order.push(pid)
  }
  walk(rootPid)
  return order
}

/** Map of pid → { ppid, args } for every descendant of rootPid. */
export function descendants(table, rootPid, excludePid = process.pid) {
  const map = new Map()
  for (const pid of descendantOrder(table, rootPid, excludePid)) {
    const row = table.get(pid)
    if (row !== undefined) map.set(pid, row)
  }
  return map
}

/* ------------------------------------------------------------- environment */

const PASSTHROUGH_PREFIX = 'DSH_RESTART_'

/**
 * Environment for a replacement DSH instance.  A desktop child is *never*
 * allowed to inherit `ELECTRON_RUN_AS_NODE`, otherwise the fresh app starts in
 * Node mode, exits within ~100ms and never opens a window.
 */
export function relaunchEnvironment(mode, environment = process.env) {
  const env = { ...environment }
  if (mode === 'desktop') {
    delete env.ELECTRON_RUN_AS_NODE
    delete env.DSH_DESKTOP_NODE_EXECUTABLE
  }
  delete env.NODE_OPTIONS
  delete env.NODE_REPL_EXTERNAL_MODULE
  return env
}

/**
 * Minimal environment for LaunchServices.  macOS `open` hands the caller's
 * environment to the app it launches, so anything DSH-specific must be gone.
 * Only the caller's own test knobs (`DSH_RESTART_*`) are passed through.
 */
export function cleanLaunchEnvironment(environment = process.env) {
  const env = {
    HOME: environment.HOME ?? '',
    USER: environment.USER ?? '',
    LOGNAME: environment.LOGNAME ?? environment.USER ?? '',
    SHELL: environment.SHELL ?? '/bin/zsh',
    TMPDIR: environment.TMPDIR ?? tmpdir(),
    LANG: environment.LANG ?? 'en_US.UTF-8',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  }
  for (const [key, value] of Object.entries(environment)) {
    if (key.startsWith(PASSTHROUGH_PREFIX)) env[key] = value
  }
  return env
}

/* -------------------------------------------------------------- app process */

/** Prefix every process of this app carries in its command line / path (macOS / Windows). */
export function appRootPrefix(appPath, platform = PLATFORM) {
  const raw = String(appPath)
  if (platform === 'darwin') {
    const normalized = raw.replace(/\/+$/, '')
    return normalized.endsWith('.app') ? `${normalized}/Contents/` : `${normalized}/`
  }
  if (platform === 'win32') {
    const normalized = raw.replace(/[\\/]+$/, '')
    const cut = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
    return cut > 0 ? normalized.slice(0, cut) : normalized
  }
  const normalized = raw.replace(/[\\/]+$/, '')
  return `${normalized === '' ? raw : dirname(normalized)}`
}

const normalizePath = (value) => {
  let path = String(value ?? '')
  if (path.startsWith('/private/')) path = path.slice('/private'.length)
  return path
}

/**
 * Is the main process of the app running?
 *
 * macOS is matched by command line (the main process launches the binary
 * without arguments, or with the legacy `-psn_*` argument).  Windows is matched
 * by executable path.
 */
export function findMainProcesses(target, table, platform = PLATFORM) {
  const found = []
  const windows = platform === 'win32'
  const mainBinary = normalizePath(target.mainBinary ?? target.appPath)
  const appPath = normalizePath(target.appPath)
  for (const [pid, row] of table) {
    if (pid === process.pid) continue
    if (windows) {
      const executable = normalizePath(row.executable ?? '')
      if (executable === '' || executable.toLowerCase() !== appPath.toLowerCase()) continue
      found.push(pid)
      continue
    }
    const args = normalizePath(row.args ?? '')
    if (!args.startsWith(mainBinary)) continue
    const rest = args.slice(mainBinary.length)
    if (rest === '' || /^ -psn_/.test(rest)) found.push(pid)
  }
  return found.sort((a, b) => a - b)
}

/** Every process that belongs to the app bundle / installation directory. */
export function findAppProcesses(target, table, platform = PLATFORM) {
  const windows = platform === 'win32'
  const prefix = normalizePath(appRootPrefix(target.appPath, platform))
  const found = []
  for (const [pid, row] of table) {
    if (pid === process.pid) continue
    const haystack = windows ? normalizePath(row.executable ?? '') : normalizePath(row.args ?? '')
    if (haystack === '') continue
    if (windows) {
      if (haystack.toLowerCase().startsWith(prefix.toLowerCase())) found.push(pid)
    } else if (haystack.startsWith(prefix)) {
      found.push(pid)
    }
  }
  return found.sort((a, b) => a - b)
}

/* ------------------------------------------------------------------ helpers */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

export function createLogger(logPath) {
  const write = (line) => {
    const text = `[${new Date().toISOString()}] ${line}\n`
    if (logPath === undefined || logPath === null) {
      process.stderr.write(text)
      return
    }
    try {
      appendFileSync(logPath, text)
    } catch {
      process.stderr.write(text)
    }
  }
  return write
}

async function waitFor(predicate, timeoutMs, intervalMs = POLL_MS) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() >= deadline) return false
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
  }
}

async function confirmAlive(predicate, durationMs, intervalMs = 250) {
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    if (!(await predicate())) return false
    await sleep(intervalMs)
  }
  return predicate()
}

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/* -------------------------------------------------------------------- stop */

function signalPid(pid, signal) {
  try {
    process.kill(pid, signal)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Stop a process tree, leaves first.  Returns the pids that were signalled. */
export async function stopTree(rootPid, log = () => {}, { signal = 'SIGTERM', graceMs = 4_000 } = {}) {
  const first = await processTable()
  const order = descendantOrder(first, rootPid)
  if (order.length === 0 && !pidAlive(rootPid)) return []
  log(`stopping process tree of ${rootPid} (${order.length} descendant(s))`)
  if (IS_WINDOWS) {
    await runCapture('taskkill', ['/PID', String(rootPid), '/T', '/F'])
    return order.length > 0 ? order : [rootPid]
  }
  for (const pid of order) signalPid(pid, signal)
  signalPid(rootPid, signal)
  const quiet = await waitFor(async () => !(await pidAlive(rootPid)) && (await appTableQuiet(order)), graceMs)
  if (!quiet) {
    const second = await processTable()
    const sweep = descendantOrder(second, rootPid)
    log(`process tree of ${rootPid} ignored ${signal}; killing ${sweep.length} process(es)`)
    for (const pid of sweep) signalPid(pid, 'SIGKILL')
    signalPid(rootPid, 'SIGKILL')
  }
  return order
}

async function appTableQuiet(pids) {
  if (pids.length === 0) return true
  for (const pid of pids) if (pidAlive(pid)) return false
  return true
}

/* ------------------------------------------------------------------ launch */

async function launchDesktop(target, log) {
  if (IS_MAC) {
    const openBinary = process.env.DSH_RESTART_OPEN_BIN || '/usr/bin/open'
    log(`launching ${target.appPath} through ${openBinary} with a clean environment`)
    const child = spawn(openBinary, ['-a', target.appPath], {
      detached: true,
      stdio: 'ignore',
      env: cleanLaunchEnvironment(),
    })
    await onceSpawned(child)
    child.unref()
    return
  }
  if (!IS_WINDOWS) {
    log(`unsupported platform ${PLATFORM}: not launching ${target.appPath}`)
    return
  }
  log(`launching ${target.appPath} directly with a clean environment`)
  const child = spawn(target.appPath, [], {
    detached: true,
    stdio: 'ignore',
    cwd: target.cwd ?? undefined,
    env: relaunchEnvironment('desktop'),
    windowsHide: false,
  })
  await onceSpawned(child)
  child.unref()
}

async function launchByBundleId(target, log) {
  const openBinary = process.env.DSH_RESTART_OPEN_BIN || '/usr/bin/open'
  log(`launching bundle ${target.appId} through ${openBinary}`)
  const child = spawn(openBinary, ['-b', target.appId], {
    detached: true,
    stdio: 'ignore',
    env: cleanLaunchEnvironment(),
  })
  await onceSpawned(child)
  child.unref()
}

function onceSpawned(child) {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
}

async function requestQuit(target, log) {
  if (IS_MAC) {
    const appId = target.appId ?? 'com.deepseek.dsh'
    log(`asking ${appId} to quit through LaunchServices`)
    try {
      const child = spawn('/usr/bin/osascript', ['-e', `tell application id "${appId}" to quit`], {
        stdio: 'ignore',
      })
      await new Promise((resolve) => {
        child.once('close', (code) => {
          log(`quit request finished with exit code ${code ?? '?'}`)
          resolve()
        })
        child.once('error', (error) => {
          log(`quit request failed: ${error?.message ?? error}`)
          resolve()
        })
      })
    } catch (error) {
      log(`quit request could not be started: ${error?.message ?? error}`)
    }
    return
  }
  if (IS_WINDOWS) {
    log(`posting a close message to ${target.mainPid}`)
    await runCapture('taskkill', ['/PID', String(target.mainPid)])
    return
  }
  log(`unsupported platform ${PLATFORM}: not sending a quit request`)
}

async function launchServicesRegistered(target) {
  if (!IS_MAC || target.appId === undefined || target.appId === null) return false
  const text = await runCapture('/usr/bin/lsappinfo', ['find', `bundleID=${target.appId}`])
  if (text === undefined) return false
  return /ASN:/.test(text)
}

/* ----------------------------------------------------------------- restart */

async function restartDesktop(target, log) {
  const mainAlive = async () => {
    const table = await processTable()
    return findMainProcesses(target, table).length > 0
  }
  const appCount = async () => {
    const table = await processTable()
    return findAppProcesses(target, table).length
  }

  await requestQuit(target, log)
  const exited = await waitFor(async () => !(await mainAlive()), QUIT_WAIT_MS, 500)
  if (!exited) {
    log(
      `main process is still alive ${Math.round(QUIT_WAIT_MS / 1000)}s after the quit request ` +
        '(quit confirmation cancelled?); leaving the app alone',
    )
    return 0
  }
  log('main process exited')

  let settled = await waitFor(async () => (await appCount()) === 0, SETTLE_MS, 250)
  if (IS_MAC) {
    const unregistered = await waitFor(async () => !(await launchServicesRegistered(target)), SETTLE_MS, 250)
    settled = settled && unregistered
  }
  if (!settled) {
    log(`app still has processes after ${Math.round(SETTLE_MS / 1000)}s; sweeping what is left`)
    const table = await processTable()
    const leftovers = findAppProcesses(target, table)
    if (leftovers.length > 0) {
      const hostPid = target.hostPid
      for (const pid of leftovers) signalPid(pid, 'SIGKILL')
      if (Number.isInteger(hostPid) && pidAlive(hostPid)) await stopTree(hostPid, log)
      await waitFor(async () => (await appCount()) === 0, 4_000, 250)
    }
  }
  log('app torn down')

  if (PAUSE_MS > 0) {
    log(`pausing ${Math.round(PAUSE_MS / 1000)}s before the first launch`)
    await sleep(PAUSE_MS)
  }

  let attempts = 0
  for (let attempt = 1; attempt <= LAUNCH_TRIES; attempt += 1) {
    attempts = attempt
    if (await mainAlive()) {
      log('a live DSH instance already exists; nothing to launch')
      return 0
    }
    log(`launch attempt ${attempt}/${LAUNCH_TRIES}`)
    try {
      await launchDesktop(target, log)
    } catch (error) {
      log(`launch attempt ${attempt} failed to start: ${error?.message ?? error}`)
    }
    const appeared = await waitFor(async () => await mainAlive(), LAUNCH_WAIT_MS, 250)
    if (!appeared) {
      log(`no live instance ${Math.round(LAUNCH_WAIT_MS / 1000)}s after attempt ${attempt}`)
    } else if (await confirmAlive(mainAlive, CONFIRM_MS)) {
      log(`relaunched ${target.appPath} (attempt ${attempt})`)
      await focusRestoredWindow(target, log)
      return 0
    } else {
      log(`instance came up and exited again (attempt ${attempt})`)
    }
    if (attempt < LAUNCH_TRIES) await sleep(Math.min(3_000, 600 * attempt))
  }

  if (IS_MAC && target.appId !== undefined && target.appId !== null) {
    log('falling back to the bundle identifier')
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (await mainAlive()) {
        log('a live DSH instance already exists; nothing to launch')
        return 0
      }
      log(`bundle-id launch attempt ${attempt}/2`)
      try {
        await launchByBundleId(target, log)
      } catch (error) {
        log(`bundle-id launch attempt ${attempt} failed to start: ${error?.message ?? error}`)
      }
      const appeared = await waitFor(async () => await mainAlive(), LAUNCH_WAIT_MS, 250)
      if (appeared && (await confirmAlive(mainAlive, CONFIRM_MS))) {
        log(`relaunched ${target.appId} (bundle-id attempt ${attempt})`)
        return 0
      }
      log(`no stable instance after bundle-id attempt ${attempt}`)
    }
  }

  log(
    `relaunch FAILED after ${attempts} attempt(s); open ${target.appPath ?? 'DSH'} manually`,
  )
  return 1
}

async function restartCli(target, log) {
  const hostPid = target.hostPid
  if (Number.isInteger(hostPid) && hostPid > 0) {
    await stopTree(hostPid, log)
    await waitFor(async () => !pidAlive(hostPid), PROCESS_WAIT_MS, POLL_MS)
  }
  await sleep(400)

  for (let attempt = 1; attempt <= LAUNCH_TRIES; attempt += 1) {
    log(`launch attempt ${attempt}/${LAUNCH_TRIES}`)
    let child
    try {
      child = spawn(target.appPath, Array.isArray(target.args) ? target.args : [], {
        detached: true,
        stdio: 'ignore',
        cwd: target.cwd ?? undefined,
        env: relaunchEnvironment('cli'),
        windowsHide: false,
      })
      await onceSpawned(child)
    } catch (error) {
      log(`launch attempt ${attempt} failed: ${error?.message ?? error}`)
      await sleep(600)
      continue
    }
    const pid = child.pid
    child.unref()
    log(`relaunched DSH as pid ${pid}`)
    if (await confirmAlive(async () => pidAlive(pid), CONFIRM_MS)) return 0
    log(`new instance exited within ${Math.round(CONFIRM_MS / 1000)}s (attempt ${attempt})`)
    await sleep(600)
  }
  log('relaunch FAILED; start DSH again manually')
  return 1
}

/* ------------------------------------------------------------ window focus */

const ENSURE_VISIBLE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$pidToFind = [int]$args[0]
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $pidToFind)
$window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
if ($null -eq $window) { exit 3 }
$pattern = $null
if (-not $window.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$pattern)) { exit 4 }
$pattern.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal)
$window.SetFocus()
exit 0
`

async function focusRestoredWindow(target, log) {
  if (!IS_WINDOWS) return
  try {
    const table = await processTable()
    const mains = findMainProcesses(target, table)
    const pid = mains[0]
    if (pid === undefined) return
    const deadline = Date.now() + WINDOW_VISIBLE_TIMEOUT_MS
    while (Date.now() < deadline) {
      const code = await new Promise((resolve) => {
        const child = spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            ENSURE_VISIBLE_SCRIPT,
            String(pid),
          ],
          { stdio: 'ignore', windowsHide: true },
        )
        child.once('close', (value) => resolve(value ?? 1))
        child.once('error', () => resolve(1))
      })
      if (code === 0) {
        log(`restored and focused the window of pid ${pid}`)
        return
      }
      if (code === 2 || code === 3 || code === 5) return
      await sleep(1_000)
    }
    log('could not restore the app window; continuing anyway')
  } catch (error) {
    log(`window restore unavailable: ${error?.message ?? error}`)
  }
}

/* ---------------------------------------------------------------- run entry */

export async function runHelper(targetPath) {
  let target
  try {
    target = JSON.parse(readFileSync(targetPath, 'utf8'))
  } catch (error) {
    process.stderr.write(`dsh-restart helper: cannot read target ${targetPath}: ${error?.message ?? error}\n`)
    return 1
  }
  const log = createLogger(target.logPath)
  try {
    log(
      `helper start pid=${process.pid} mode=${target.mode} platform=${PLATFORM} ` +
        `hostPid=${target.hostPid ?? '-'} mainPid=${target.mainPid ?? '-'} app=${target.appPath}`,
    )
    if (target.dryRun === true) {
      log('dry run: no process will be stopped and nothing will be launched')
      return 0
    }
    if (!SUPPORTED_PLATFORMS.has(PLATFORM)) {
      log(`unsupported platform ${PLATFORM}: refusing to restart; supported: ${[...SUPPORTED_PLATFORMS].join(', ')}`)
      return 1
    }
    await sleep(Number.isFinite(target.delayMs) ? target.delayMs : DEFAULT_DELAY_MS)
    if (target.mode === 'cli') return await restartCli(target, log)
    return await restartDesktop(target, log)
  } catch (error) {
    log(`helper failed: ${error?.stack ?? error}`)
    return 1
  } finally {
    try {
      rmSync(targetPath, { force: true })
    } catch {}
  }
}

export function defaultLogPath(stamp = Date.now()) {
  return join(tmpdir(), 'dsh-restart', `restart-${stamp}.log`)
}

export function ensureDirectory(path) {
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {}
}

function isDirectRun() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  const self = fileURLToPath(import.meta.url)
  if (entry === self) return true
  // macOS reports /var/... in argv but resolves the entry to /private/var/...,
  // so a plain string comparison silently turns the helper into a no-op.
  try {
    return realpathSync(entry) === realpathSync(self)
  } catch {
    return false
  }
}

if (isDirectRun()) {
  const targetPath = process.argv[2]
  if (targetPath === undefined) {
    process.stderr.write('usage: node restart.mjs <target.json>\n')
    process.exit(2)
  }
  runHelper(targetPath).then((code) => process.exit(code))
}
