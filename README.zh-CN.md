<h1 align="center">dsh-restart-button</h1>

<p align="center"><a href="./README.md">English</a> · <strong>简体中文</strong></p>

<p align="center">
  <a href="https://github.com/justin0406/dsh-restart-button/releases/latest"><img alt="GitHub release" src="https://img.shields.io/github/v/release/justin0406/dsh-restart-button" /></a>
  <a href="https://github.com/justin0406/dsh-restart-button/actions/workflows/test.yml"><img alt="CI" src="https://github.com/justin0406/dsh-restart-button/actions/workflows/test.yml/badge.svg?branch=main" /></a>
  <a href="https://github.com/justin0406/dsh-restart-button"><img alt="GitHub stars" src="https://img.shields.io/github/stars/justin0406/dsh-restart-button" /></a>
  <a href="https://github.com/justin0406/dsh-restart-button/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
</p>

给 DeepSeek Harness 加一个「重启」按钮：侧边栏底部（设置按钮旁）多出一个小按钮，点一下弹出确认框，
确认后 DSH 走正常退出流程并自动重新启动。

- **桌面应用**（Electron）：整个应用退出后重新打开；
- **`dsh web`**：替换服务端进程树，页面在新 Host 就绪后自动刷新。

macOS 与 Windows 的两种形态都支持。Linux 不做支持（无法实机验证），在 Linux 上按钮会提示
`unsupported-platform`，不会误操作。

需要 **Node.js 20 及以上**（见 `package.json` 的 `engines`）；插件本身没有运行时依赖。

## 支持矩阵

| 运行形态 | macOS | Windows |
|---|---|---|
| 桌面应用（Electron） | ✅ 实机验证（2.1.0，2026-11-04：退出→干净拉起→自动恢复，8.2s） | ✅ 实机验证（2.2.1，2026-11-05）；2.3.1 的拆除顺序改动有测试锁定，但尚未重新实机确认 |
| `dsh web`（CLI 载体） | ✅ 实机验证（2.1.0，2026-11-04：进程树替换 + 页面自动重连） | ✅ 同一实现（进程表用 CIM/PowerShell） |

入口既不是 `dsh-desktop-host` 也不是 `@deepseek-ai/dsh` 时无法重启：bridge 返回
`restart/unsupported` 与诊断信息，弹窗里说明原因，不会误触发任何操作。

## 行为

1. 点侧边栏按钮 → 弹窗询问是否重启，并按当前运行形态说明影响（桌面版会整个退出）。
2. 确认后 Host 立刻返回 202（必须先答复，否则进程被杀后前端拿不到响应），后台助手接棒。
3. 助手按形态执行：
   - **desktop（macOS）**：用标准 quit AppleEvent 请求应用退出 → 等主进程消失（最多 90 秒；若在退出
     确认框里取消，写 `leaving the app alone` 并放弃）→ 等 App 包内所有进程消失，并等 LaunchServices
     注销该 bundle（`lsappinfo`）→ 静置 3 秒 → 用**干净环境**拉起 → 新主进程持续存活 3 秒才算成功；
     失败按退避重试（`open -a` 4 次，再按 bundle id 兜底 2 次）。
   - **desktop（Windows）**：先向 shell 发礼貌关闭（`taskkill /PID`，不带 `/F`，只发 `WM_CLOSE`）→
     `QUIT_GRACE_MS`（8 秒）后仍在（DSH 关窗只是隐藏到托盘）则强制拆除，**先杀 shell、再杀 host**，
     这样 shell 的监工不会看到一次「无人认领」的 host 退出，也就不会闪崩溃弹窗 → 用干净环境直接拉起
     可执行文件 → 要求新主进程持续存活。
   - **cli**：停掉当前 Host 的进程树 → 等退出 → 用原来的 argv 与工作目录重新 spawn → 确认新进程持续存活。
4. web 模式下前端每 1.2 秒轮询 `/api/dsh-restart/status`，发现 `hostPid` 变了就 `location.reload()`；
   25 秒后提示可能正停在退出确认框，120 秒仍未回来则提示手动刷新。

完整的超时与重试参数见[环境开关](#环境开关)。

## 为什么必须用干净环境拉起

Desktop 的 Host 子进程由 Electron 主进程以 `ELECTRON_RUN_AS_NODE=1` 启动，插件就跑在这个 Host 里。
macOS 的 `open` 会把调用者的环境原样传给新启动的 App —— 于是被拉起的 DSH 以 **Node 模式** 启动，
`app.whenReady()` 里抢不到单实例锁、约 100ms 后 `exit 0`，全程不开窗，日志里只有一条
`electron/shell/common/mac/codesign_util.cc:79] task_name_for_pid: (os/kern) failure (5)`（即 NodeMain 路径）。

`open` 只要 LaunchServices 接受请求就返回 0，所以「发了 open」绝不能当作「重启成功」。本插件因此：

- 拉起时用 `env -i` 只保留 `HOME/USER/LOGNAME/SHELL/TMPDIR/LANG/PATH`（`DSH_RESTART_*` 测试开关透传）；
- Windows 直接 spawn 时也删除 `ELECTRON_RUN_AS_NODE`、`DSH_DESKTOP_NODE_EXECUTABLE`、
  `NODE_OPTIONS`、`NODE_REPL_EXTERNAL_MODULE`；
- 拉起后必须看到新主进程继续存活才写 `relaunched`。

Windows 上是同一个陷阱的另一种形态：直接 spawn 可执行文件会继承助手的环境，而助手本身正是被它要替换的
host 以 `ELECTRON_RUN_AS_NODE=1` 启动的。spawn 前删掉这些变量，新实例才会是「应用」而不是裸 Node 进程。

## 为什么 Windows 要先杀 shell 再杀 host

Electron 主进程（shell）监工 host 子进程，把**任何**非自己发起的 host 退出都当成崩溃，弹出
「应用无法启动或已意外停止」的恢复对话框。所以先杀 host 必然会在 shell 自己被杀前的一瞬间闪出该弹窗。
强制拆除现在改为先杀 shell，等 host 倒下时已经没有监工可以上报。进程表读不到时，用插件加载时记录的
`mainPid` 作为兜底的 shell pid。

## 接口

两个端点都在 `/api/dsh-restart` 下，统一返回 `{ok:true,value}` 或 `{ok:false,error:{code,message}}`。

### `GET|POST /api/dsh-restart/status`

```jsonc
{
  "ok": true,
  "value": {
    "supported": true,          // 本进程能否自行重启
    "mode": "desktop",          // "desktop" | "cli" | null
    "platform": "darwin",       // process.platform
    "reason": null,             // 不可重启的原因："unsupported-platform" / "not-a-dsh-carrier"
                                // / "disabled-by-mode" / "app-bundle-not-found"
    "appPath": "/Applications/DeepSeek Harness.app",
    "appId": "com.deepseek.dsh",// macOS 取自 Info.plist，Windows 为 null
    "mainBinary": "...",        // Electron 主可执行文件
    "mainPid": 4000,            // Electron 主进程，cli 模式为 null
    "hostPid": 4242,            // 本插件所在的进程
    "launchEnvironment": "minimal (LaunchServices, clean env)",
    "inheritedNodeMode": [],    // 本进程里仍存在的 ELECTRON_RUN_AS_NODE 等变量
    "delayMs": 900,             // 助手动作前的延迟（200–10000）
    "dryRun": false,
    "restarting": false,        // 已有助手在跑
    "lastRequest": null,        // 上次重启的 {at, mode, helperPid, logPath}
    "logDirectory": "/var/folders/.../dsh-restart",
    "token": "…",               // POST /restart 必须回传
    "diagnostics": { "platform": "darwin", "entry": "…", "pid": 4242, "ppid": 4000 }
  }
}
```

`GET` 与 `POST` 行为完全一致，都不会产生副作用。

### `POST /api/dsh-restart/restart`

请求体可选，可覆盖两项：

```jsonc
{ "token": "…", "dryRun": true, "delayMs": 1500 }
```

`token` 必填（见下文）。`dryRun` 只对本次调用生效；`delayMs` 会被钳制在 200–10000 ms。

| 状态码 | code | 含义 |
|---|---|---|
| 202 | — | `{accepted:true, mode, helperPid, logPath}`，重启已交给助手 |
| 202 | — | `{alreadyRequested:true}`，已有重启在跑，本次没有新动作 |
| 200 | — | 干跑：`{accepted:false, dryRun:true, plan:{…}}`，没有杀进程也没有拉起 |
| 400 | `bridge/invalid-body` | 请求体不是 JSON 对象 |
| 403 | `bridge/forbidden` | 对端、`Host`、`Sec-Fetch-Site` 或 `Origin` 不受信 |
| 403 | `bridge/bad-token` | 缺少或回传了错误的 `token` |
| 405 | `bridge/method-not-allowed` | 重启端点用了 POST 以外的方法 |
| 409 | `restart/unsupported` | 本进程无法自行重启，`diagnostics` 给出原因 |
| 413 | `bridge/body-too-large` | 请求体超过 16 KiB |
| 500 | `restart/spawn-failed` | 助手进程无法启动 |
| 500 | `restart/helper-exited` | 助手在写出第一行日志前就退出了 |
| 500 | `bridge/failed` | 路由处理器抛出异常，具体原因见插件日志 |

### 安全约束

只接受回环地址；`Host` 头必须是回环名；拒绝 `sec-fetch-site: cross-site`；`Origin` 只允许缺省、
`null`、`dsh-app://app` 或 `webServer.getOrigin()`；写操作只接受 POST；请求体上限 16 KiB。
此外 `POST /restart` 必须回传 `GET /status` 下发的 `token`——这补上了最后一种情况：既不发送
`Origin` 也不发送 `Sec-Fetch-Site` 的浏览器（Safari 16.4 之前）里，跨站表单 POST 会被当成同源请求。
局域网/手机浏览器访问会被 403 拒绝。

## 日志

- macOS：`$TMPDIR/dsh-restart/restart-<时间戳>.log`
- Windows：`%TEMP%\dsh-restart\restart-<时间戳>.log`

排错关键字：

| 关键字 | 含义 |
|---|---|
| `helper start` | 助手启动，包含 mode / hostPid / mainPid / app 路径 |
| `asking … to quit` / `close politely` | 已发出退出请求（AppleEvent / 不带 `/F` 的 `taskkill`） |
| `leaving the app alone` | 主进程一直没退出（通常是退出确认框被取消），插件没有动它 |
| `stopping desktop shell process N before its host` | Windows 强制拆除：先杀 shell，避免闪崩溃弹窗 |
| `app torn down` | 整个 App/安装目录的进程都退干净了 |
| `pausing Ns before the first launch` | 拆除与拉起之间的静置期 |
| `launch attempt i/N` | 第 i 次拉起 |
| `bundle-id launch attempt i/2` | macOS 兜底：按 bundle id 拉起 |
| `instance came up and exited again` | 新实例起来又退出（环境或单实例锁问题），会继续重试 |
| `relaunched ... (attempt i)` | 成功，且新主进程已持续存活 |
| `relaunched DSH as pid N` | CLI 模式：替换进程已启动 |
| `restored and focused the window of pid N` | Windows：已把最小化的窗口还原并置前 |
| `working directory ... is gone` | 记录的工作目录已消失，CLI 改从 `HOME` 拉起 |
| `process table unavailable` | `ps`/PowerShell 读不到进程表；助手只停根进程，不假设其余进程已消失 |
| `relaunch FAILED` | 全部尝试失败，需手动打开 |
| `unsupported platform … refusing to restart` | Linux 上助手拒绝执行任何操作 |

插件启动时会清理超过一周的日志与残留 `target-*.json`。

## 干跑

`DSH_RESTART_DRY_RUN=1`（环境变量）或 bundle patch 里 `config: { dryRun: true }`：
`POST /restart` 只返回将要写出的任务文件，不杀进程、不拉起。弹窗会直接说明「没有真的重启」，
不会去等一个永远不会出现的新 Host。

## 环境开关

| 变量 | 默认值 | 作用 |
|---|---|---|
| `DSH_RESTART_MODE` | *（未设置）* | `desktop` / `cli` / `off`。强制指定载体形态，或彻底停用 bridge（`status` 报 `disabled-by-mode`，`restart` 返回 409）。 |
| `DSH_RESTART_DRY_RUN` | *（未设置）* | `1` = 干跑。 |
| `DSH_RESTART_QUIT_WAIT_MS` | 90000 | desktop（macOS）：主进程退出前最多等多久，超时即放弃。 |
| `DSH_RESTART_QUIT_GRACE_MS` | 8000 | desktop（Windows）：礼貌关闭后等多久再强制拆除进程树。 |
| `DSH_RESTART_SETTLE_MS` | 6000 | 主进程退出后，旧应用要多久彻底消失。 |
| `DSH_RESTART_PAUSE_MS` | 3000 | 拆除与首次拉起之间的静置期。 |
| `DSH_RESTART_CONFIRM_MS` | 3000 | 新实例需持续存活多久才算成功。 |
| `DSH_RESTART_LAUNCH_WAIT_MS` | 15000 | 拉起后等新实例出现的最长时间。 |
| `DSH_RESTART_LAUNCH_TRIES` | 4 | 拉起尝试次数（之后 macOS 还有 2 次 bundle id 兜底）。 |
| `DSH_RESTART_PROCESS_WAIT_MS` | 20000 | 进程收到信号后允许多久退出（cli 模式）。 |
| `DSH_RESTART_OPEN_BIN` | `/usr/bin/open` | 覆盖启动器（仅 macOS，测试用）。 |

所有 `DSH_RESTART_*` 变量都会穿过干净环境传给助手，桌面模式下同样生效。取值必须是非负数字，
否则回退到默认值。

注意干净环境只保留 `HOME/USER/LOGNAME/SHELL/TMPDIR/LANG/PATH`，因此被拉起的应用**不会**继承
`http_proxy`、自定义 `NODE_*` 或 shell 注入的变量——这是刻意为之（见下文），但也意味着依赖这些变量的
启动方式必须改由 DSH 自身配置提供。

## 测试

```bash
npm test        # 四套测试，无需安装依赖
```

- `test/restart.test.mjs`：纯函数（macOS/Windows 进程表解析、进程树倒序、环境清洗、App 进程匹配、日志），
  以及「读不到的进程表是未知、不是空」这一契约。
- `test/host.test.mjs`：路由注册、回环/Origin/方法与请求体校验、status token、macOS/Windows 载体识别、
  非支持平台拒绝、任务文件结构。
- `test/client.test.mjs`：用迷你 React 渲染真实组件（插槽、弹窗、确认、等待 hostPid 变化后刷新、干跑、
  错误态、i18n）。
- `test/helper.test.mjs`：真实运行 `restart.mjs` 替换一个假 CLI 进程树，验证只杀该杀的、拉起后确认存活。

CI 在 macOS 与 Linux、Node 20/22 上跑全部四套（`.github/workflows/test.yml`）。`/var` 与
`/private/var` 的用例仅限 macOS，其他平台跳过。Linux 上助手套件断言的是「拒绝执行」
（`unsupported platform`、不杀任何进程）而非进程替换——助手只在 macOS/Windows 上执行重启。

## 安装 / 卸载

```bash
git clone https://github.com/justin0406/dsh-restart-button.git
npm test
npm pack        # 产出 dsh-restart-button-x.y.z.tgz
```

在 DSH 的插件管理里安装这个 tgz（或本地目录）：

```text
plugin_manager install_bundle  target=/absolute/path/to/dsh-restart-button
plugin_manager remove_bundle   target=dsh-restart-button
```

本地目录安装会以 `link:` 形式进入 profile；首次安装需要重启一次应用才会生效，之后改代码用
`set_plugin enabled=false → true` 即可热加载（HMR 监听会忽略 `node_modules`，所以要靠行级开关触发重新 import）。

## 踩过的坑：/var 与 /private/var

macOS 的 `TMPDIR` 在 `argv` 里是 `/var/folders/...`，而 `import.meta.url` 会解析成
`/private/var/folders/...`。助手脚本若用 `process.argv[1] === fileURLToPath(import.meta.url)`
判断「是否被直接执行」，两者永不相等 → 助手静默退出、什么都不做（表现为点了重启后界面一直等待）。
现在改用 `realpathSync` 比较两侧，并在 `test/helper.test.mjs` 里用一个 `/var` 路径的用例锁住这个行为。

## 变更记录

### 2.3.1

- Windows 桌面版重启不再先闪一下「应用无法启动或已意外停止」的崩溃弹窗。原先助手先拆 host，而
  Electron 主进程（shell）把**任何**非自己发起的 host 退出都当成崩溃上报，于是在 shell 自己被杀前的
  一瞬间弹出了该对话框。现在改为**先杀 shell、再杀 host**，宿主退出时已没有监工。
- `test/restart.test.mjs` 在 Windows 上也能跑了：macOS 夹具显式指定平台，探针子进程改用
  `fileURLToPath`/`import.meta.url` 拼 URL（不再手工拼 `file://`），并新增「shell 先于 host 停止」的断言。

### 2.3.0

- 读不到的进程表现在按**未知**处理，不再当成「App 已经退出」。超过 8 MB 的输出原先会被截尾成无法
  解析的 JSON，`ps`/PowerShell 查询失败也会返回空表——两者都会让助手误判旧实例已退出，从而重复拉起
  （撞单实例锁）或留下占着端口的子进程。`processTable()` 现在返回 `null`，所有谓词把 `null` 当「继续等」。
- Windows 窗口恢复在重启成功后不再空转 90 秒：循环改为在 exit code 3（窗口还没出来）继续轮询、
  exit code 4（拿不到 `WindowPattern`）放弃——这才是脚本真实会返回的码，原来的 2 和 5 不可达。
- `413` 能正常送达了。原先请求体读取器在处理器答复前就销毁了 socket，超限请求表现为网络错误而不是
  `bridge/body-too-large`。
- `POST /restart` 现在要求回传 `GET /status` 下发的 `token`（否则 `bridge/bad-token`），作为既不发送
  `Origin` 也不发送 `Sec-Fetch-Site` 的浏览器场景下的纵深防御。
- 助手启动窗口内再点一次不会起第二个助手：`restarting` 在第一个 `await` 之前就置位。
- CLI 模式记录载体的工作目录，目录消失时回退到 `HOME`，避免项目目录被删后重启以 `ENOENT` 失败。
- 干跑会在弹窗里直接说明，不再干等一个永远不会出现的新 Host 两分钟。
- 载体识别不再被路径里含 `dsh` 的脚本误触发（如 `/home/x/dsh-notes/main.js`），只认 `@deepseek-ai/dsh`
  或名为 `dsh` 的可执行文件。
- 插件启动时清理超过一周的助手日志与残留 `target-*.json`。
- 新增 CI（macOS + Linux，Node 20/22），并把所有 `DSH_RESTART_*` 开关写进文档。

### 2.2.1

- Windows：`stopTree` 不再用 `taskkill /T /F`。助手本身是被它要杀的宿主 spawn 出来的，`/T` 会把
  助手一起杀掉、重启半途中断。现在按快照从叶子往根逐个 pid 杀。
- Windows：desktop 退出路径增加强杀兜底。单独的 `taskkill /PID` 只会发 `WM_CLOSE`，而 DSH 关闭窗口
  是隐藏到托盘、不会退出——旧代码会干等 90 秒后放弃（日志 "leaving the app alone"）。现在先礼貌关闭，
  `QUIT_GRACE_MS`（8 秒）后强制关闭进程树。
- Windows：2.2.1 已在 Windows 实机确认可用（2026-11-05）。
- Windows：窗口恢复恢复可用。pid 之前作为 `-Command` 的尾随参数传入，PowerShell 会把它并入命令文本而
  不是 `$args`，脚本于是去找 pid 0、以退出码 3 结束。现在改用 `DSH_RESTART_WINDOW_PID` 环境变量传递，
  并且 `SetFocus` 失败不再影响结果。

### 2.1.0

- 修复点「重启」后界面永远停在「正在等待新的进程接管…」：助手入口判定在 macOS 上因
  `/var/…` 与 `/private/var/…` 永不相等而静默 `exit 0`。改为两侧 `realpathSync` 比较，并新增回归用例。
- 宿主侧新增保底：助手启动后 1.2 秒内没有写出日志就返回 `restart/helper-exited`，界面立即报错而不是干等两分钟。
- 前端弹窗重写为自绘固定层（不再依赖 `@deepseek-ai/dsh-client-ui-primitives`）：store 用不可变快照，
  修复「点击无反应、弹窗出现即无法关闭」的问题；支持 × / 取消 / 点遮罩 / Esc 四种关闭方式。

### 2.0.0

- 融合两个实现：desktop 模式走「礼貌退出 + 干净环境拉起 + 持续存活确认」，`dsh web` 模式走
  「进程树替换」；新增确认弹窗与 web 端自动重连。

## 已知限制

- **Windows 的 2.3.1 拆除顺序尚未重新实机验证**：先杀 shell 的改动有源码级断言锁定，但它修的可观察症状
  （崩溃弹窗一闪）只能在 Windows 上实际重启一次桌面版才能确认。
- **Windows 退出路径**：先尝试 `taskkill /PID` 礼貌关闭（保留 DSH 自己弹确认的可能），但关窗口只会
  隐藏到托盘，因此 `QUIT_GRACE_MS`（8 秒，可用 `DSH_RESTART_QUIT_GRACE_MS` 调整）后助手会强制关闭
  整棵进程树；拉起后要求新主进程持续存活 3 秒才算成功。退出路径本身已在 2.2.1 实机验证。
- **拉起环境是刻意极简的**：依赖继承来的 `http_proxy`/`NODE_*`/shell 变量的 DSH，重启后会失去这些变量。
  这正是避免下文「Node 模式启动失败」的手段，因此不提供配置项。
- `--port 0` 启动的 `dsh web` 重启后会换端口，前端轮询用的是相对路径，只能提示手动访问新地址；
  默认固定端口时无此问题。
- 桌面版重启必然中断当前会话/turn（进程整体退出）。
- 窗口恢复（最小化 → 正常并置前）只在 Windows 实现。

## License

MIT
