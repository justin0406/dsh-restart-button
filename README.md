# 重启 DSH · Restart button for DeepSeek Harness

> 给 DeepSeek Harness 加一个「重启」按钮：桌面版整应用重启，`dsh web` 服务端进程替换 + 页面自动重连。
> 支持 macOS / Windows 的 desktop 与 web 两种形态；已在 macOS 两种形态实机验证。


在 DeepSeek Harness 侧边栏底部（设置按钮旁）加一个「重启 DSH」按钮。点一下会弹出确认框，
确认后 DSH 走正常退出流程并自动重新启动：桌面版重启整个应用，`dsh web` 方式运行时替换服务端进程、
页面自动刷新。

融合了两个实现：macOS 桌面版已经实机验证的「优雅退出 → 等干净 → 干净环境拉起 → 确认存活」流程，
以及 Windows 优先版（`dsh-restart@0.2.1`，已在 Windows 实机跑通）的双模式判定、进程树快照、确认弹窗和 web 自动重连。

只支持 macOS 与 Windows。Linux 不做支持（无法实机验证），在 Linux 上按钮会提示
`unsupported-platform`，不会误操作。

## 支持矩阵

| 运行形态 | macOS | Windows |
|---|---|---|
| 桌面应用（Electron） | ✅ 实机验证（2.1.0，2026-11-04：退出→干净拉起→自动恢复，8.2s） | ✅ 逻辑来自 Windows 实机验证过的 `0.2.1`（见「已知限制」里的两处融合改动） |
| `dsh web`（CLI 载体） | ✅ 实机验证（2.1.0，2026-11-04：进程树替换 + 页面自动重连） | ✅ 同上（进程表用 CIM/PowerShell） |

不可重启的位置（入口不是 `dsh-desktop-host` 或 `@deepseek-ai/dsh`）会返回
`restart/unsupported` 和诊断信息；弹窗里显示原因，按钮不会误触发。

## 行为

1. 点侧边栏按钮 → 弹窗询问是否重启，并按运行形态说明影响（桌面版会整个退出）。
2. 确认后 Host 立刻返回 202（必须先答复，否则进程被杀后前端拿不到响应），后台助手接棒。
3. 助手按形态执行：
   - **desktop**：请求应用退出（macOS 用标准 quit AppleEvent、Windows 用 `taskkill /PID` 发关闭消息）
     → 等主进程消失（最多 90 秒；若在退出确认框里取消，写
     `leaving the app alone` 并放弃）→ 等整个安装目录/App 包的进程都消失（macOS 还额外等
     LaunchServices 注销，`lsappinfo`）→ 静置 3 秒 → 用**干净环境**拉起 →
     新主进程持续存活 3 秒才算成功，失败退避重试（`open -a` 4 次 → bundle id 兜底 2 次）。
   - **cli**：停掉当前 Host 的进程树 → 等退出 → 用原来的 argv 重新 spawn → 确认新进程持续存活。
4. web 模式下前端轮询 `/api/dsh-restart/status`，发现 `hostPid` 变了就 `location.reload()`；
   120 秒仍未回来则提示手动刷新。

## 为什么必须用干净环境拉起（关键坑）

Desktop 的 Host 子进程由 Electron 主进程以 `ELECTRON_RUN_AS_NODE=1` 启动，插件就跑在这个 Host 里。
macOS 的 `open` 会把调用者的环境原样传给新启动的 App —— 于是被拉起的 DSH 以 **Node 模式** 启动，
`app.whenReady()` 里抢不到单实例锁、约 100ms 后 `exit 0`，全程不开窗，日志里只有一条
`electron/shell/common/mac/codesign_util.cc:79] task_name_for_pid: (os/kern) failure (5)`（即 NodeMain 路径）。

`open` 对 LaunchServices 的请求成功就返回 0，所以「发了 open」绝不能当作「重启成功」。本插件因此：

- 拉起时用 `env -i` 只保留 `HOME/USER/LOGNAME/SHELL/TMPDIR/LANG/PATH`（`DSH_RESTART_*` 测试开关透传）；
- Windows 直接 spawn 时也删除 `ELECTRON_RUN_AS_NODE`、`DSH_DESKTOP_NODE_EXECUTABLE`、
  `NODE_OPTIONS`、`NODE_REPL_EXTERNAL_MODULE`；
- 拉起后必须看到新主进程继续存活才写 `relaunched`。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET / POST | `/api/dsh-restart/status` | `{ok:true,value:{supported,mode,platform,reason,appPath,mainPid,hostPid,launchEnvironment,inheritedNodeMode,delayMs,dryRun,restarting,lastRequest,logDirectory}}` |
| POST | `/api/dsh-restart/restart` | 202 已接受；重复请求 202 `alreadyRequested`；不可重启 409 `restart/unsupported`；干跑 200 `plan`；失败 500 `restart/spawn-failed` |

安全约束：只接受回环地址；`Host` 头必须是回环名；拒绝 `sec-fetch-site: cross-site`；`Origin` 只允许
缺省、`null`、`dsh-app://app` 或 `webServer.getOrigin()`；写操作只接受 POST；请求体上限 16 KiB。
局域网/手机浏览器访问会被 403 拒绝。

## 日志

- macOS：`$TMPDIR/dsh-restart/restart-<时间戳>.log`
- Windows：`%TEMP%\dsh-restart\restart-<时间戳>.log`

排错关键字：

| 关键字 | 含义 |
|---|---|
| `helper start` | 助手启动，包含 mode / hostPid / mainPid / app 路径 |
| `leaving the app alone` | 主进程一直没退出（通常是退出确认框被取消），插件没有动它 |
| `app torn down after` | 整个应用/安装目录的进程都退干净了 |
| `relaunch attempt i/N` | 第 i 次拉起 |
| `instance came up and exited again` | 新实例起来又退出（环境或单实例锁问题），会继续重试 |
| `relaunched ... (attempt i)` | 成功，且新主进程已持续存活 |
| `relaunch FAILED` | 全部尝试失败，需手动打开 |

## 干跑

`DSH_RESTART_DRY_RUN=1`（环境变量）或 bundle patch 里 `config: { dryRun: true }`：
`POST /restart` 只返回将要写出的任务文件，不杀进程、不拉起。

## 测试

```bash
cd ~/Documents/DSH/dsh-restart-plugin && npm test
```

四套：

- `test/restart.test.mjs`：纯函数（macOS/Windows 进程表解析、进程树倒序、环境清洗、App 进程匹配、日志）。
- `test/host.test.mjs`：路由注册、回环/Origin/方法与请求体校验、macOS/Windows 载体识别、非支持平台拒绝、任务文件结构。
- `test/client.test.mjs`：用迷你 React 渲染真实组件（插槽、弹窗、确认、等待 hostPid 变化后刷新、错误态、i18n）。
- `test/helper.test.mjs`：真实运行 `restart.mjs` 替换一个假 CLI 进程树，验证只杀该杀的、拉起后确认存活。

## 从源码安装（开发）

```bash
git clone https://github.com/justin0406/dsh-restart-button.git
cd dsh-restart-button
npm test                      # 四套测试，无需依赖
npm pack                      # 产出 dsh-restart-x.y.z.tgz，可在 DSH 的插件管理里从文件安装
```

目录：`index.js`（宿主半：bridge 路由 + 载体识别 + 启动助手）、`restart.mjs`（跨平台重启助手）、
`client.js`（侧边栏按钮与确认弹窗）、`cordis.patch.yml`（bundle 补丁）、`locale/`、`test/`。

## 安装 / 卸载

```text
plugin_manager install_bundle  target=/Users/xuzeteng/Documents/DSH/dsh-restart-plugin
plugin_manager remove_bundle   target=@local/dsh-restart
```

本地目录安装会以 `link:` 形式进入 profile；首次安装需要重启一次应用才会生效，
之后改代码用 `set_plugin enabled=false → true` 即可热加载（HMR 监听会忽略 `node_modules`，
所以要靠行级开关触发重新 import）。

## 踩过的坑：/var 与 /private/var

macOS 的 `TMPDIR` 在 `argv` 里是 `/var/folders/...`，而 `import.meta.url` 会解析成 `/private/var/folders/...`。助手脚本用 `process.argv[1] === fileURLToPath(import.meta.url)` 判断「是否被直接执行」时，两者永不相等 → 助手静默退出、什么都不做（表现为点了重启界面一直等待）。现在改用 `realpathSync` 比较两侧，并在 `test/helper.test.mjs` 里用一个 `/var` 路径的用例锁住这个行为。

## 变更记录

### 2.1.0

- 修复点「重启」后界面永远停在「正在等待新的进程接管…」：助手脚本用 `argv[1] === fileURLToPath(import.meta.url)` 判断是否作为入口执行，macOS 上 `/var/…` 与 `/private/var/…` 永不相等 → 助手静默 `exit 0`，什么也没做。改为两侧 `realpathSync` 比较，并新增 `/var` 路径回归用例。
- 宿主侧新增保底：助手启动后 1.2 秒内没有写出日志就返回 `restart/helper-exited`，界面立即报错而不是干等两分钟。
- 前端弹窗重写为自绘固定层（不再依赖 `@deepseek-ai/dsh-client-ui-primitives`）：store 用不可变快照，修复「点击无反应、弹窗出现即无法关闭」的问题；支持 × / 取消 / 点遮罩 / Esc 四种关闭方式。

### 2.0.0

- 融合两个实现：desktop 模式走「礼貌退出 + 干净环境拉起 + 持续存活确认」，`dsh web` 模式走「进程树替换」；新增确认弹窗与 web 端自动重连。

## 已知限制

- **Windows 上有两处融合改动**：退出方式从 `taskkill /T /F` 强杀改为先 `taskkill /PID` 礼貌关闭
  （保留 DSH 自己的退出确认），拉起后额外要求新主进程持续存活 3 秒才算成功。其余（进程检测、
  CIM 快照、直接 spawn、UIAutomation 窗口恢复）沿用 `0.2.1` 在 Windows 上实测通过的实现。
- `--port 0` 启动的 `dsh web` 重启后会换端口，前端轮询用的是相对路径，只能提示手动访问新地址；
  默认固定端口时无此问题。
- 桌面版重启必然中断当前会话/turn（进程整体退出）。
- 窗口恢复（最小化 → 正常并置前）只在 Windows 实现。
