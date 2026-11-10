<h1 align="center">dsh-restart-button</h1>

<p align="center"><strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a></p>

<p align="center">
  <a href="https://github.com/justin0406/dsh-restart-button/releases/latest"><img alt="GitHub release" src="https://img.shields.io/github/v/release/justin0406/dsh-restart-button" /></a>
  <a href="https://github.com/justin0406/dsh-restart-button"><img alt="GitHub stars" src="https://img.shields.io/github/stars/justin0406/dsh-restart-button" /></a>
  <a href="https://github.com/justin0406/dsh-restart-button/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
</p>

A one-click restart button for [DeepSeek Harness](https://github.com/deepseek-ai). It adds a small
button next to **Settings** at the bottom of the sidebar; clicking it opens a confirmation dialog and
then restarts DSH properly:

- **desktop app** (Electron): the app quits through its normal quit flow and is relaunched;
- **`dsh web`**: the server process tree is replaced and the page reloads once the new host answers.

Both shapes are supported on **macOS** and **Windows**. Linux is not supported (it could not be
verified on real hardware); on Linux the button reports `unsupported-platform` and never misbehaves.

## Support matrix

| Shape | macOS | Windows |
|---|---|---|
| Desktop app (Electron) | ✅ verified on hardware (2.1.0, 2026-11-04: quit → clean relaunch → recovery, 8.2s) | ✅ verified on hardware (2.2.1, 2026-11-05) |
| `dsh web` (CLI carrier) | ✅ verified on hardware (2.1.0, 2026-11-04: process-tree replacement + automatic page reload) | ✅ same implementation (process table via CIM/PowerShell) |

Where the plugin cannot restart DSH (the entry point is neither `dsh-desktop-host` nor
`@deepseek-ai/dsh`), the bridge answers `restart/unsupported` with diagnostics, the dialog explains
why, and nothing is killed.

## Behavior

1. Click the sidebar button → a dialog asks for confirmation and explains the impact for the current
   shape (the desktop app quits completely).
2. On confirmation the host answers `202` immediately — it has to, because the process is about to
   die and the page needs the response — and a detached helper takes over.
3. The helper branches by shape:
   - **desktop**: ask the app to quit (standard quit AppleEvent on macOS, `taskkill /PID` on Windows)
     → wait for the main process to disappear (up to 90 s; if the quit confirmation was cancelled it
     logs `leaving the app alone` and gives up) → wait for every process under the app bundle /
     install directory to disappear (macOS additionally waits for LaunchServices to drop the
     registration, via `lsappinfo`) → pause 3 s → launch with a **clean environment** → the new main
     process has to stay alive for 3 s to count as success; failures are retried with backoff
     (`open -a` 4 times, then the bundle id twice).
   - **cli**: stop the current host's process tree → wait for exit → spawn again with the original
     argv → confirm the replacement stays alive.
4. In web mode the page polls `/api/dsh-restart/status` and calls `location.reload()` as soon as
   `hostPid` changes; after 120 s it asks for a manual refresh.

## Why the relaunch needs a clean environment

The desktop Host child is spawned by the Electron main process with `ELECTRON_RUN_AS_NODE=1`, and the
plugin runs inside that Host. On macOS `open` passes the caller's environment to the app it launches
— so the new DSH instance starts in **Node mode**, fails to take the single-instance lock in
`app.whenReady()`, and exits 0 about 100 ms later without ever opening a window. The only log line is
`electron/shell/common/mac/codesign_util.cc:79] task_name_for_pid: (os/kern) failure (5)` (the
`NodeMain()` path).

`open` returns 0 as soon as LaunchServices accepts the request, so "I called open" must never be
treated as "the restart worked". Therefore the plugin:

- launches with `env -i` keeping only `HOME/USER/LOGNAME/SHELL/TMPDIR/LANG/PATH` (plus `DSH_RESTART_*`
  test switches);
- when spawning directly on Windows, deletes `ELECTRON_RUN_AS_NODE`, `DSH_DESKTOP_NODE_EXECUTABLE`,
  `NODE_OPTIONS` and `NODE_REPL_EXTERNAL_MODULE`;
- only writes `relaunched` once the new main process has stayed alive.

## API

| Method | Path | Notes |
|---|---|---|
| GET / POST | `/api/dsh-restart/status` | `{ok:true,value:{supported,mode,platform,reason,appPath,mainPid,hostPid,launchEnvironment,inheritedNodeMode,delayMs,dryRun,restarting,lastRequest,logDirectory,token}}` |
| POST | `/api/dsh-restart/restart` | 202 accepted; 202 `alreadyRequested` for duplicates; 409 `restart/unsupported`; 200 `plan` in dry run; 403 `bridge/bad-token`; 500 `restart/spawn-failed` / `restart/helper-exited` |

Security: loopback peers only; the `Host` header must be a loopback name; `sec-fetch-site: cross-site`
is rejected; `Origin` must be absent, `null`, `dsh-app://app`, or `webServer.getOrigin()`; mutating
calls must be POST; bodies are capped at 16 KiB. On top of that, `POST /restart` must echo the
`token` that `GET /status` just handed out — that closes the remaining hole for browsers that send
neither `Origin` nor `Sec-Fetch-Site` (Safari before 16.4), where a cross-site form post would
otherwise look like a same-origin request. Requests from the LAN or a phone browser get 403.

## Logs

- macOS: `$TMPDIR/dsh-restart/restart-<timestamp>.log`
- Windows: `%TEMP%\dsh-restart\restart-<timestamp>.log`

| Keyword | Meaning |
|---|---|
| `helper start` | helper started; includes mode / hostPid / mainPid / app path |
| `leaving the app alone` | the main process never exited (usually the quit confirmation was cancelled); nothing was done |
| `app torn down` | every process of the app/install directory is gone |
| `launch attempt i/N` | launch attempt i |
| `bundle-id launch attempt i/2` | macOS fallback launch through the bundle identifier |
| `instance came up and exited again` | the new instance started and died again (environment or single-instance lock); retrying |
| `relaunched ... (attempt i)` | success, and the new main process is stable |
| `relaunched DSH as pid N` | CLI mode: the replacement process started |
| `working directory ... is gone` | the recorded cwd disappeared; the CLI was relaunched from `HOME` |
| `process table unavailable` | `ps`/PowerShell could not be read; the helper stopped the root without its descendants instead of assuming everything was already gone |
| `relaunch FAILED` | every attempt failed; open the app manually |

Logs and orphaned `target-*.json` files older than a week are swept when the plugin starts.

## Dry run

Set `DSH_RESTART_DRY_RUN=1`, or `config: { dryRun: true }` in the bundle patch: `POST /restart` only
returns the target file it would write and neither kills nor launches anything. The dialog reports
that nothing was restarted instead of waiting for a new host.

## Environment switches

| Variable | Effect |
|---|---|
| `DSH_RESTART_MODE` | `desktop`, `cli`, or `off`. Forces the carrier shape, or disables the bridge entirely (`status` reports `disabled-by-mode`, `restart` answers 409). |
| `DSH_RESTART_DRY_RUN` | `1` = dry run (see above). |
| `DSH_RESTART_QUIT_WAIT_MS` / `_QUIT_GRACE_MS` / `_SETTLE_MS` / `_PAUSE_MS` / `_CONFIRM_MS` / `_LAUNCH_WAIT_MS` / `_LAUNCH_TRIES` / `_PROCESS_WAIT_MS` | Timing knobs, read by the helper at startup. |
| `DSH_RESTART_OPEN_BIN` | Overrides `/usr/bin/open` (macOS only; used by tests). |

All `DSH_RESTART_*` variables are passed through the clean LaunchServices environment, so they reach
the helper even in desktop mode.

## Tests

```bash
npm test        # no dependencies required
```

Four suites:

- `test/restart.test.mjs` — pure functions (macOS/Windows process-table parsing, descendant order,
  environment cleaning, app-process matching, logging) plus the "an unreadable process table is
  unknown, never empty" contract.
- `test/host.test.mjs` — route registration, loopback/Origin/method/body validation, the status token,
  macOS/Windows carrier detection, unsupported platforms, target-file shape.
- `test/client.test.mjs` — mounts the real components with a tiny React (slots, dialog, confirm,
  reload after the host pid changes, dry run, error states, i18n).
- `test/helper.test.mjs` — actually runs `restart.mjs` against a fake CLI process tree and checks that
  it kills only what it should and confirms the replacement.

CI runs all four on macOS and Linux with Node 20 and 22 (`.github/workflows/test.yml`). The
`/var` vs `/private/var` case is macOS-only and skips elsewhere. On Linux the helper suite asserts
the refusal (`unsupported platform`, nothing killed) instead of the replacement, because the helper
only restarts on macOS/Windows.

## Install

From a checkout:

```bash
git clone https://github.com/justin0406/dsh-restart-button.git
npm test
npm pack        # produces dsh-restart-button-x.y.z.tgz
```

Then, in DSH, install the tarball (or the directory) through the plugin manager:

```text
plugin_manager install_bundle  target=/absolute/path/to/dsh-restart-button
plugin_manager remove_bundle   target=dsh-restart-button
```

Installing from a local directory adds a `link:` dependency to the profile; the first install requires
one app restart to take effect. After that, code changes can be hot-loaded with
`set_plugin enabled=false → true` (the HMR watcher ignores `node_modules`, so the row-level toggle is
what triggers a re-import).

## Pitfalls hit while building this

**`/var` vs `/private/var`.** macOS reports `TMPDIR` as `/var/folders/...` in `argv`, while
`import.meta.url` resolves to `/private/var/folders/...`. A helper that decides "am I the entry point?"
with `process.argv[1] === fileURLToPath(import.meta.url)` is therefore never the entry point: it exits
silently and does nothing, which looks like "the button waits forever". The helper now compares
`realpathSync` on both sides, and `test/helper.test.mjs` locks this in with a `/var`-path case.

## Changelog

### 2.3.0

- An unreadable process table is now treated as **unknown**, not as "the app is gone". Captures that
  overflow 8 MB used to be truncated into unparseable JSON, and a failing `ps`/PowerShell query
  returned an empty table; both made the helper believe the old instance had exited, so it could
  launch a second copy (single-instance lock failure) or leave orphaned children holding the port.
  `processTable()` now returns `null`, and every predicate treats that as "keep waiting".
- Windows window restore no longer spins for 90 s after a successful restart: the loop polls on exit
  code 3 (window not there yet) and gives up on 4 (no `WindowPattern`), which is what the script
  actually produces. Codes 2 and 5 were unreachable.
- `413` responses are delivered again. The body reader destroyed the socket before the handler could
  answer, so an oversized request surfaced as a network error instead of `bridge/body-too-large`.
- `POST /restart` now requires the `token` that `GET /status` hands out (`bridge/bad-token`
  otherwise). Defence in depth for browsers that send neither `Origin` nor `Sec-Fetch-Site`.
- A second click inside the helper-start window no longer starts a second helper: `restarting` is
  claimed before the first `await`.
- CLI mode records the carrier's working directory and falls back to `HOME` if it has disappeared, so
  a restart no longer fails with `ENOENT` after the project directory was deleted.
- Dry run is reported in the dialog instead of waiting two minutes for a host that will never come.
- Carrier detection no longer fires on paths that merely contain `dsh`
  (`/home/x/dsh-notes/main.js`); only `@deepseek-ai/dsh` or a `dsh`-named executable counts.
- Helper logs and orphaned `target-*.json` files older than a week are swept at startup.
- Added CI (macOS + Linux, Node 20/22) and documented every `DSH_RESTART_*` switch.

### 2.2.1

- Windows: `stopTree` no longer uses `taskkill /T /F`. The helper is spawned by the host it is killing,
  so `/T` terminated the helper halfway through the restart. Process trees are now taken from the
  snapshot and killed leaf first, one pid at a time.
- Windows: the desktop quit path falls back to forcing the trees down. A plain `taskkill /PID` only
  posts `WM_CLOSE`, and DSH hides to the tray instead of quitting — the old code waited 90 s and gave
  up ("leaving the app alone"). The polite close is still attempted first; `QUIT_GRACE_MS` (8 s)
  later the app is force-closed.
- Windows: confirmed working on real hardware (2.2.1, 2026-11-05).
- Windows: window restore works again. The pid used to be passed as a trailing `-Command` argument,
  which PowerShell folds into the command text instead of `$args`, so the script searched for process
  0 and exited with code 3. It now travels through `DSH_RESTART_WINDOW_PID`, and a failing `SetFocus`
  is ignored.

### 2.1.0

- Fixed "the dialog stays on *waiting for the new process* forever": the helper's entry-point check
  compared `/var/...` with `/private/var/...` and silently exited. Now `realpathSync` on both sides,
  plus a regression test.
- Host side: if the helper does not write its log within 1.2 s, the bridge returns
  `restart/helper-exited` instead of leaving the UI waiting for two minutes.
- The dialog was rewritten as a self-drawn fixed layer (no `@deepseek-ai/dsh-client-ui-primitives`
  dependency): immutable store snapshots fix "click does nothing" and "dialog opens but cannot be
  closed"; it can be closed with ×, Cancel, backdrop click, or Esc.

### 2.0.0

- Merged two implementations: desktop mode (graceful quit → clean relaunch → liveness confirmation)
  and web mode (process-tree replacement), plus the confirmation dialog and automatic page reload.

## Known limitations

- **Windows quit path**: quitting keeps a polite `taskkill /PID` first (so DSH could still show its
  own confirmation), but because closing the window only hides DSH to the tray, the helper forces the
  process trees down after `QUIT_GRACE_MS` (8 s, `DSH_RESTART_QUIT_GRACE_MS`). The relaunch requires
  the new main process to stay alive for 3 s. This path is verified on Windows hardware as of 2.2.1.
- A `dsh web` started with `--port 0` comes back on a different port; the page polls relative paths,
  so it can only ask you to open the new address. Fixed ports are fine.
- Restarting the desktop app necessarily interrupts the current turn/session.
- Window restore (minimised → normal and focused) is implemented for Windows only.

## License

MIT
