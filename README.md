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
| Desktop app (Electron) | ✅ verified on hardware (2.1.0, 2026-11-04: quit → clean relaunch → recovery, 8.2s) | ✅ logic taken from `dsh-restart@0.2.1`, which was verified on Windows (two adaptations are listed under *Known limitations*) |
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
| GET / POST | `/api/dsh-restart/status` | `{ok:true,value:{supported,mode,platform,reason,appPath,mainPid,hostPid,launchEnvironment,inheritedNodeMode,delayMs,dryRun,restarting,lastRequest,logDirectory}}` |
| POST | `/api/dsh-restart/restart` | 202 accepted; 202 `alreadyRequested` for duplicates; 409 `restart/unsupported`; 200 `plan` in dry run; 500 `restart/spawn-failed` / `restart/helper-exited` |

Security: loopback peers only; the `Host` header must be a loopback name; `sec-fetch-site: cross-site`
is rejected; `Origin` must be absent, `null`, `dsh-app://app`, or `webServer.getOrigin()`; mutating
calls must be POST; bodies are capped at 16 KiB. Requests from the LAN or a phone browser get 403.

## Logs

- macOS: `$TMPDIR/dsh-restart/restart-<timestamp>.log`
- Windows: `%TEMP%\dsh-restart\restart-<timestamp>.log`

| Keyword | Meaning |
|---|---|
| `helper start` | helper started; includes mode / hostPid / mainPid / app path |
| `leaving the app alone` | the main process never exited (usually the quit confirmation was cancelled); nothing was done |
| `app torn down after` | every process of the app/install directory is gone |
| `relaunch attempt i/N` | launch attempt i |
| `instance came up and exited again` | the new instance started and died again (environment or single-instance lock); retrying |
| `relaunched ... (attempt i)` | success, and the new main process is stable |
| `relaunch FAILED` | every attempt failed; open the app manually |

## Dry run

Set `DSH_RESTART_DRY_RUN=1`, or `config: { dryRun: true }` in the bundle patch: `POST /restart` only
returns the target file it would write and neither kills nor launches anything.

## Tests

```bash
npm test        # no dependencies required
```

Four suites:

- `test/restart.test.mjs` — pure functions (macOS/Windows process-table parsing, descendant order,
  environment cleaning, app-process matching, logging).
- `test/host.test.mjs` — route registration, loopback/Origin/method/body validation, macOS/Windows
  carrier detection, unsupported platforms, target-file shape.
- `test/client.test.mjs` — mounts the real components with a tiny React (slots, dialog, confirm,
  reload after the host pid changes, error states, i18n).
- `test/helper.test.mjs` — actually runs `restart.mjs` against a fake CLI process tree and checks that
  it kills only what it should and confirms the replacement.

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

- **Two adaptations on Windows**: quitting uses `taskkill /PID` (graceful) instead of
  `taskkill /T /F`, and the relaunch additionally requires the new main process to stay alive for 3 s.
  Everything else (process detection, CIM snapshot, direct spawn, UIAutomation window restore) comes
  from `0.2.1`, which was verified on Windows.
- A `dsh web` started with `--port 0` comes back on a different port; the page polls relative paths,
  so it can only ask you to open the new address. Fixed ports are fine.
- Restarting the desktop app necessarily interrupts the current turn/session.
- Window restore (minimised → normal and focused) is implemented for Windows only.

## License

MIT
