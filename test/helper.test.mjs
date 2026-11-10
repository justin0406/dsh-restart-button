// End-to-end test of the real helper (`restart.mjs`) for the CLI carrier: it
// stops a live fake DSH process tree and starts a replacement that must stay
// alive. The helper is executed as a child process exactly the way the host
// half runs it.
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert'

const HELPER = fileURLToPath(new URL('../restart.mjs', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'dsh-restart-e2e-'))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// A stand-in for the DSH CLI process: it must keep running, or the helper's
// liveness confirmation fails.
const fakeCli = join(directory, 'fake-dsh-cli.mjs')
writeFileSync(
  fakeCli,
  `process.on('SIGTERM', () => process.exit(0))\nprocess.on('SIGINT', () => process.exit(0))\nsetInterval(() => {}, 1000)\n`,
)

const logPath = join(directory, 'restart.log')
const helperEnv = {
  ...process.env,
  DSH_RESTART_CONFIRM_MS: '1200',
  DSH_RESTART_PROCESS_WAIT_MS: '8000',
  DSH_RESTART_SETTLE_MS: '500',
  DSH_RESTART_PAUSE_MS: '0',
  DSH_RESTART_LAUNCH_WAIT_MS: '5000',
  DSH_RESTART_LAUNCH_TRIES: '2',
}

function startFakeHost() {
  const child = spawn(process.execPath, [fakeCli], { detached: true, stdio: 'ignore' })
  child.unref()
  return child
}

function runHelperAt(helperPath, targetPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [helperPath, targetPath], { stdio: ['ignore', 'pipe', 'pipe'], env: helperEnv })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

function runHelper(targetPath) {
  return runHelperAt(HELPER, targetPath)
}

function writeTarget(target) {
  const path = join(directory, `target-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
  writeFileSync(path, JSON.stringify(target))
  return path
}

function baseTarget(hostPid, overrides = {}) {
  return {
    mode: 'cli',
    hostPid,
    mainPid: null,
    appPath: process.execPath,
    appId: null,
    mainBinary: null,
    args: [fakeCli],
    logPath,
    delayMs: 0,
    dryRun: false,
    ...overrides,
  }
}

function readLog() {
  return existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
}

let fakeHosts = []
try {
  // ---- 1. dry run: nothing may be stopped, nothing launched -----------------
  const dryHost = startFakeHost()
  fakeHosts.push(dryHost)
  await sleep(300)
  const dryTarget = writeTarget(baseTarget(dryHost.pid, { dryRun: true }))
  const dry = await runHelper(dryTarget)
  assert.equal(dry.code, 0, `dry run must exit 0 (stderr: ${dry.stderr})`)
  assert.match(readLog(), /dry run: no process will be stopped/u)
  assert.equal(pidAlive(dryHost.pid), true, 'dry run must leave the host alone')
  assert.equal(existsSync(dryTarget), false, 'target file is removed after the run')
  console.log('ok: dry run stops nothing and launches nothing')

  // ---- 1b. the /var -> /private/var symlink must not turn the helper into a
  // no-op: when the copied helper is invoked through its TMPDIR path (which is
  // how the host half always invokes it), argv[1] is /var/... while
  // import.meta.url resolves to /private/var/... This only exists on macOS.
  if (process.platform === 'darwin') {
    const varDirectory = join(tmpdir(), 'dsh-restart-varpath-test')
    rmSync(varDirectory, { recursive: true, force: true })
    mkdirSync(varDirectory, { recursive: true })
    const varHelper = join(varDirectory, 'restart.mjs')
    copyFileSync(HELPER, varHelper)
    assert.ok(varHelper.startsWith('/var/'), `the macOS TMPDIR must be a /var path (got ${varHelper})`)
    const varHost = startFakeHost()
    fakeHosts.push(varHost)
    await sleep(300)
    const varTarget = writeTarget(baseTarget(varHost.pid, { dryRun: true }))
    const varRun = await runHelperAt(varHelper, varTarget)
    assert.equal(varRun.code, 0, `helper must exit 0 when run from a /var path (stderr: ${varRun.stderr})`)
    assert.match(readLog(), /helper start pid=\d+ mode=cli/u, 'invoking the helper through /var/... must still run it')
    rmSync(varDirectory, { recursive: true, force: true })
    console.log('ok: helper still runs when invoked through its /var TMPDIR path')
  } else {
    console.log('skip: /var symlink case only applies to macOS')
  }

  // ---- 2. real CLI restart ---------------------------------------------------
  // The replacement can only be observed where the helper actually restarts
  // (darwin/win32), and the process search below needs `ps`, so the full check
  // runs on macOS. On any other platform the helper must refuse instead:
  // exit 1, a clear log line, and nothing killed — the safety property CI
  // (Linux) locks in.
  if (process.platform === 'darwin') {
    const host = startFakeHost()
    fakeHosts.push(host)
    await sleep(300)
    const target = writeTarget(baseTarget(host.pid))
    const result = await runHelper(target)
    const log = readLog()
    assert.equal(result.code, 0, `helper must exit 0 (stderr: ${result.stderr})\n${log}`)
    assert.match(log, /helper start pid=\d+ mode=cli/u)
    assert.match(log, /relaunched DSH as pid \d+/u, `helper must report the replacement pid:\n${log}`)
    assert.equal(pidAlive(host.pid), false, 'the old host process must be gone')

    // The replacement is a detached node running the fake CLI; find it, prove it
    // is alive, then stop it so the test leaves nothing behind.
    const ps = spawn('ps', ['-A', '-o', 'pid=', '-o', 'args='])
    let psOut = ''
    ps.stdout.on('data', (chunk) => {
      psOut += chunk
    })
    await new Promise((resolve) => ps.on('close', resolve))
    const replacement = psOut
      .split('\n')
      .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
      .filter(Boolean)
      .find((match) => match[2].includes(fakeCli) && Number(match[1]) !== process.pid)
    assert.ok(replacement, 'the helper must have started a replacement process')
    const replacementPid = Number(replacement[1])
    fakeHosts.push({ pid: replacementPid })
    assert.equal(pidAlive(replacementPid), true, 'the replacement must still be alive')
    console.log('ok: CLI restart replaced the host with pid', replacementPid)
  } else if (process.platform === 'win32') {
    console.log('skip: the replacement search needs ps; the Windows path is verified on hardware')
  } else {
    const host = startFakeHost()
    fakeHosts.push(host)
    await sleep(300)
    const target = writeTarget(baseTarget(host.pid))
    const result = await runHelper(target)
    assert.equal(result.code, 1, 'the helper must refuse on an unsupported platform')
    assert.match(readLog(), /unsupported platform .*refusing to restart/u, 'the refusal must be logged')
    assert.equal(pidAlive(host.pid), true, 'the refusal must leave the host alone')
    assert.equal(existsSync(target), false, 'the target file is removed even on refusal')
    console.log('ok: helper refuses to restart on an unsupported platform and kills nothing')
  }

  // ---- 3. missing target file: fail loudly, exit non-zero -------------------
  const missing = await runHelper(join(directory, 'does-not-exist.json'))
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /cannot read target/u)
  console.log('ok: missing target file exits 1 with a reason')
} finally {
  for (const child of fakeHosts) {
    try {
      if (child?.pid !== undefined) process.kill(child.pid, 'SIGKILL')
    } catch {}
  }
  // The helper launches detached replacements, so sweep anything still running
  // this fixture's script rather than relying on the pids we happened to see.
  try {
    const ps = spawn('ps', ['-A', '-o', 'pid=', '-o', 'args='])
    let out = ''
    ps.stdout.on('data', (chunk) => {
      out += chunk
    })
    await new Promise((resolve) => ps.on('close', resolve))
    for (const line of out.split('\n')) {
      if (!line.includes(fakeCli)) continue
      const pid = Number(/^\s*(\d+)/.exec(line)?.[1])
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
    }
  } catch {}
  rmSync(directory, { recursive: true, force: true })
}

console.log('\nALL HELPER TESTS PASSED')
