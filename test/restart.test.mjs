// Unit tests for the pure parts of restart.mjs: process-table parsing, tree
// ordering, relaunch environments and app-process matching. These functions are
// what makes the helper platform neutral, so they run on any host.
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const restart = await import(new URL('../restart.mjs', import.meta.url).href)

/* ------------------------------------------------------------ posix tables */

const posix = restart.parsePosixProcessTable(
  [
    '    1     0 /sbin/launchd',
    '  4000     1 /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
    '  4242  4000 /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness --expose-internals /x/index.js',
    '  4300  4242 /Applications/DeepSeek Harness.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper',
    '  5000  4000 -psn_0_12345',
    'garbage line without pids',
  ].join('\n'),
)
assert.equal(posix.size, 5)
assert.deepEqual(posix.get(4000), {
  ppid: 1,
  args: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
})
assert.equal(posix.get(4242).ppid, 4000)
assert.match(posix.get(4300).args, /Frameworks\/Helper\.app/u)
console.log('ok: posix process table parsing')

/* ---------------------------------------------------------- windows tables */

const windows = restart.parseWindowsProcessTable(
  JSON.stringify([
    { ProcessId: 100, ParentProcessId: 4, ExecutablePath: 'C:\\App\\DSH.exe', CommandLine: '"C:\\App\\DSH.exe"' },
    { ProcessId: 200, ParentProcessId: 100, ExecutablePath: 'C:\\App\\DSH.exe', CommandLine: '"C:\\App\\DSH.exe" --expose-internals host.js' },
  ]),
)
assert.equal(windows.size, 2)
assert.equal(windows.get(200).ppid, 100)
assert.equal(windows.get(100).executable, 'C:\\App\\DSH.exe')
assert.equal(windows.get(200).args, '"C:\\App\\DSH.exe" --expose-internals host.js')

// PowerShell emits a bare object when a single process matches.
const windowsSingle = restart.parseWindowsProcessTable(
  JSON.stringify({ ProcessId: 7, ParentProcessId: 1, ExecutablePath: 'C:\\App\\DSH.exe' }),
)
assert.equal(windowsSingle.size, 1)
assert.equal(windowsSingle.get(7).executable, 'C:\\App\\DSH.exe')

// Broken output must degrade to an empty table instead of throwing.
assert.equal(restart.parseWindowsProcessTable('not json').size, 0)
assert.equal(restart.parseWindowsProcessTable('').size, 0)
console.log('ok: windows process table parsing (array, single object, garbage)')

/* -------------------------------------------------- unreadable process table */

// A table that could not be read is *unknown*, never empty: callers use `null`
// to keep waiting instead of concluding that the app is gone. `ps` is invoked
// with a bogus flag so the query really fails.
const realRunCapture = restart.runCapture
assert.equal(typeof realRunCapture, 'function')

// A capture that overflows must fail instead of being truncated into
// unparseable JSON that then reads as "no processes at all".
const overflow = await restart.runCapture(
  process.execPath,
  ['-e', "process.stdout.write('x'.repeat(20 * 1024 * 1024))"],
  20_000,
)
assert.equal(overflow, undefined, 'an oversized capture must fail, not truncate')

// A command that exits non-zero (or is missing) also yields undefined, which
// processTable turns into null.
const failed = await restart.runCapture('/nonexistent/binary-for-dsh-restart-test', [])
assert.equal(failed, undefined, 'a failing command must not be reported as empty output')
console.log('ok: an oversized or failing capture reports unknown, not empty')

// processTable maps every unusable capture to null rather than an empty map.
assert.equal(await restart.processTable('darwin', async () => undefined), null, 'a failed query is unknown')
assert.equal(await restart.processTable('darwin', async () => ''), null, 'unparseable output is unknown')
assert.equal(await restart.processTable('win32', async () => 'not json'), null, 'broken JSON is unknown')
const usable = await restart.processTable('darwin', async () => '  1   0 /sbin/launchd\n')
assert.equal(usable.size, 1, 'a usable table is returned as-is')
console.log('ok: processTable reports null for every unusable capture')

/* -------------------------------------------------------- descendants order */

const tree = new Map([
  [4000, { ppid: 1, args: 'main' }],
  [4242, { ppid: 4000, args: 'host' }],
  [4300, { ppid: 4242, args: 'helper' }],
  [4400, { ppid: 4242, args: 'worker' }],
  [9999, { ppid: 1, args: 'other' }],
])
const order = restart.descendantOrder(tree, 4000, -1)
assert.deepEqual(order, [4300, 4400, 4242, 4000], 'children must come before their parents')
const excluded = restart.descendantOrder(tree, 4000, 4242)
assert.equal(excluded.includes(4242), false, 'the helper itself must be excluded')
assert.equal(excluded.includes(9999), false, 'unrelated processes must be excluded')
assert.deepEqual([...restart.descendants(tree, 4242, -1).keys()], [4300, 4400, 4242])
console.log('ok: descendant ordering is bottom-up and self-excluding')

/* ------------------------------------------------------------- environments */

const inherited = {
  HOME: '/Users/me',
  USER: 'me',
  LOGNAME: 'me',
  SHELL: '/bin/zsh',
  TMPDIR: '/var/folders/tmp',
  LANG: 'zh_CN.UTF-8',
  PATH: '/usr/local/bin:/usr/bin',
  ELECTRON_RUN_AS_NODE: '1',
  DSH_DESKTOP_NODE_EXECUTABLE: '/app/DeepSeek Harness',
  NODE_OPTIONS: '--inspect',
  NODE_REPL_EXTERNAL_MODULE: '/x',
  DSH_RESTART_CONFIRM_MS: '1500',
  SECRET: 'do-not-copy',
}

const desktopEnv = restart.relaunchEnvironment('desktop', inherited)
assert.equal('ELECTRON_RUN_AS_NODE' in desktopEnv, false, 'desktop relaunch must not inherit node mode')
assert.equal('DSH_DESKTOP_NODE_EXECUTABLE' in desktopEnv, false)
assert.equal('NODE_OPTIONS' in desktopEnv, false)
assert.equal('NODE_REPL_EXTERNAL_MODULE' in desktopEnv, false)
assert.equal(desktopEnv.HOME, '/Users/me')

const cliEnv = restart.relaunchEnvironment('cli', inherited)
assert.equal(cliEnv.ELECTRON_RUN_AS_NODE, '1', 'cli relaunch keeps the carrier environment')
assert.equal('NODE_OPTIONS' in cliEnv, false, 'dev flags must not leak into the replacement')

const clean = restart.cleanLaunchEnvironment(inherited)
assert.deepEqual(Object.keys(clean).sort(), [
  'DSH_RESTART_CONFIRM_MS',
  'HOME',
  'LANG',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'USER',
])
assert.equal(clean.PATH, '/usr/bin:/bin:/usr/sbin:/sbin')
assert.equal(clean.DSH_RESTART_CONFIRM_MS, '1500', 'test knobs pass through')
assert.equal('SECRET' in clean, false, 'unrelated variables are dropped')
console.log('ok: relaunch and LaunchServices environments are sanitised')

/* ------------------------------------------------------------- app matching */

assert.equal(restart.appRootPrefix('/Applications/DeepSeek Harness.app', 'darwin'), '/Applications/DeepSeek Harness.app/Contents/')
assert.equal(restart.appRootPrefix('/Applications/DeepSeek Harness.app/', 'darwin'), '/Applications/DeepSeek Harness.app/Contents/')
assert.equal(restart.appRootPrefix('C:\\App\\DSH.exe', 'win32'), 'C:\\App')
console.log('ok: app root prefixes per platform')

const macTarget = {
  appPath: '/Applications/DeepSeek Harness.app',
  mainBinary: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
}

const macTable = new Map([
  [4000, { ppid: 1, args: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' }],
  [4001, { ppid: 1, args: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness -psn_0_55' }],
  [4242, { ppid: 4000, args: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness --expose-internals /x/host.js' }],
  [4300, { ppid: 4242, args: '/Applications/DeepSeek Harness.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper' }],
  [5000, { ppid: 1, args: '/usr/bin/some-other-tool' }],
])

const macMains = restart.findMainProcesses(macTarget, macTable)
assert.deepEqual(macMains, [4000, 4001], 'only bare/psn launches count as the app main process')

const macApp = restart.findAppProcesses(macTarget, macTable)
assert.deepEqual(macApp, [4000, 4001, 4242, 4300], 'every process under the bundle belongs to the app')
console.log('ok: macOS main/app process matching')

const winTarget = { appPath: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe' }
const winTable = new Map([
  [100, { ppid: 4, executable: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe', args: '' }],
  [200, { ppid: 100, executable: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe', args: '--expose-internals host.js' }],
  [300, { ppid: 100, executable: 'C:\\Program Files\\DeepSeek Harness\\resources\\helper.exe', args: '' }],
  [400, { ppid: 4, executable: 'C:\\Windows\\explorer.exe', args: '' }],
])
assert.deepEqual(restart.findMainProcesses(winTarget, winTable, 'win32'), [100, 200])
assert.deepEqual(restart.findAppProcesses(winTarget, winTable, 'win32'), [100, 200, 300])
console.log('ok: windows main/app process matching')

/* ------------------------------------------------------------------- logger */

const directory = mkdtempSync(join(tmpdir(), 'dsh-restart-test-'))
try {
  const logPath = restart.defaultLogPath(1234)
  assert.match(logPath, /dsh-restart[/\\]restart-1234\.log$/u)
  const write = restart.createLogger(join(directory, 'restart.log'))
  write('hello')
  write('world')
  const text = readFileSync(join(directory, 'restart.log'), 'utf8')
  assert.match(text, /hello/u)
  assert.match(text, /world/u)
  assert.match(text, /^\[\d{4}-\d{2}-\d{2}T/u)
  console.log('ok: logger writes timestamped lines')

  // A missing directory falls back to stderr instead of throwing.
  const fallback = restart.createLogger(join(directory, 'missing', 'nested', 'restart.log'))
  const original = process.stderr.write
  let captured = ''
  process.stderr.write = (chunk) => {
    captured += String(chunk)
    return true
  }
  try {
    fallback('fallback line')
  } finally {
    process.stderr.write = original
  }
  assert.match(captured, /fallback line/u)
  console.log('ok: logger falls back to stderr')
} finally {
  rmSync(directory, { recursive: true, force: true })
}

/* ------------------------------------------------- windows quit hardening */

// 2.2.1: the helper is spawned by the very host it has to kill, so taskkill /T
// would take the helper down midway through a Windows restart. Keep that out.
const helperSource = readFileSync(new URL('../restart.mjs', import.meta.url), 'utf8')
assert.ok(
  !helperSource.includes("'taskkill', ['/PID', String(rootPid), '/T', '/F']"),
  'stopTree must not use taskkill /T on Windows',
)
assert.ok(!helperSource.includes("'/T', '/F'"), 'no taskkill /T anywhere in the helper')
assert.ok(helperSource.includes('QUIT_GRACE_MS'), 'Windows quit grace period is present')
console.log('ok: Windows tree kill never uses taskkill /T')

// A window close only hides DSH to the tray on Windows, so the polite close has
// to be followed by a forced teardown. Assert the ordering in the source.
const polite = helperSource.indexOf('asking ${target.mainPid} to close politely')
const forced = helperSource.indexOf('DSH hides to the tray instead of quitting')
assert.ok(polite > 0, 'polite close is logged')
assert.ok(forced > polite, 'forced teardown follows the polite close')
console.log('ok: Windows quit path escalates from polite close to forced teardown')

// The window-restore loop must give up on exit code 4 (no WindowPattern) and
// keep polling on 3 (window not there yet). The old table waited on 4 and
// bailed on 3, which meant a successful restart spun for 90 s.
const giveUp = /if \(code === 4\) return/u
assert.ok(giveUp.test(helperSource), 'window restore must stop retrying on exit code 4')
assert.ok(!/code === 3 \|\|/u.test(helperSource), 'window restore must keep polling on exit code 3')
assert.ok(!/code === 5/u.test(helperSource), 'exit code 5 is not produced by the script')
console.log('ok: window restore retries on 3 and gives up on 4')

/* -------------------------------------------------- relaunch working directory */

const cwdDirectory = mkdtempSync(join(tmpdir(), 'dsh-restart-cwd-'))
try {
  assert.equal(restart.resolveWorkingDirectory(cwdDirectory), cwdDirectory, 'a live directory is kept')
  const gone = restart.resolveWorkingDirectory(join(cwdDirectory, 'deleted'))
  assert.equal(gone, process.env.HOME, 'a missing directory falls back to HOME')
  assert.equal(restart.resolveWorkingDirectory(undefined), undefined, 'no recorded cwd stays undefined')
  assert.equal(restart.resolveWorkingDirectory(''), undefined)
  const lines = []
  restart.resolveWorkingDirectory(join(cwdDirectory, 'deleted'), (line) => lines.push(line))
  assert.match(lines.join('\n'), /relaunching from/u, 'the fallback is logged')
  console.log('ok: relaunch cwd falls back to HOME when it disappeared')
} finally {
  rmSync(cwdDirectory, { recursive: true, force: true })
}

// The numeric knobs must honour their environment overrides; checks run in a
// child process because the constants are bound at import time.
const probe = spawnSync(
  process.execPath,
  [
    '-e',
    "import(new URL('./restart.mjs', 'file://' + process.cwd() + '/')).then((m) => console.log(m.QUIT_GRACE_MS + ':' + m.CONFIRM_MS))",
  ],
  {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, DSH_RESTART_QUIT_GRACE_MS: '1234', DSH_RESTART_CONFIRM_MS: '2500' },
    encoding: 'utf8',
  },
)
assert.equal(probe.status, 0, `probe failed: ${probe.stderr}`)
assert.equal(probe.stdout.trim(), '1234:2500')
console.log('ok: timing knobs honour DSH_RESTART_* overrides')

console.log('\nALL RESTART UNIT TESTS PASSED')
