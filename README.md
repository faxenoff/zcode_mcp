# zcode-mcp

把 [zcode](https://zcode.z.ai) coding agent 封装成 MCP 工具,供外部 agent(Codex、Claude Code、Cursor……)调用:**调用方负责思考和拆解任务,zcode 负责实际写代码**。省 token、省订阅——贵模型只出思路,活儿交给本地 zcode/GLM 干。

```
┌────────────┐   MCP (stdio)   ┌──────────────────┐  ZCode Protocol (stdio)  ┌─────────────────────┐
│  Codex/GPT │ ──────────────▶ │    zcode-mcp     │ ───────────────────────▶ │ zcode app-server    │
│  (大脑)    │ ◀────────────── │  (翻译层)        │ ◀─────────────────────── │ (GLM-5.3 干活)      │
└────────────┘                 └──────────────────┘                          └─────────────────────┘
```

zcode 自身没有 `mcp serve` 服务端模式,CLI 的 `-p` 无头模式又要求先选模型而无法在命令行指定。本工具通过逆向 ZCode 桌面版驱动 agent 的内部协议(`zcode app-server`),完整解决了这些问题:指定模型、多轮会话、事件流、任务取消全部可用。

## 提供的 MCP 工具

| 工具 | 说明 |
|---|---|
| `zcode_run` | 委派一个开发任务给 zcode。参数:`prompt`(必填)、`cwd`(项目目录)、`mode`(plan/build/edit/yolo,默认 yolo)、`model`(默认 GLM-5.3)、`reasoning_level`(low/high/max)、`session_id`(续接上一轮)、`timeout_ms`(默认 10 分钟,上限 2 小时;超时后见 "Process lifecycle")。返回 zcode 的最终答复 + `session_id` + 工具使用/token/耗时统计 |
| `zcode_check` | 检查后端可用性:二进制路径、凭据、可用模型列表 |
| `zcode_sessions` | 列出某工作区的最近会话(可作为 `session_id` 续接) |

## 前置条件

1. **ZCode 桌面版**已安装,且**登录过一次**——登录凭据存放在 `~/.zcode/v2/credentials.json`,zcode-mcp 复用它们,无需再次登录。此后桌面版**无需再运行**:provider 配置由 zcode-mcp 自行引导(优先用 `~/.zcode/v2/runtime/provider/` 下已物化的配置;没有则从安装目录自带的 `resources/config/provider/zcode-builtin.json` 复制到 `~/.zcode-mcp/`),builtin revision 在本地按 `zcode-builtin:<revision>:sha256(<配置绝对路径>)` 确定性推导,不依赖桌面版日志。coding-plan api-key 没有可读的过期时间:若模型请求开始报鉴权错误,在桌面版重新登录一次(刷新 credentials.json)并重启 MCP server 即可。
2. Node.js ≥ 18。
3. 构建本工具:
   ```bash
   git clone https://github.com/TechYan/zcode_mcp.git
   cd zcode_mcp
   npm install && npm run build
   ```

## Windows (this fork)

Upstream is macOS-only. This fork (faxenoff/zcode_mcp) makes the same code run on Windows:

- `ZCODE_BIN` defaults to `%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs`; any absolute `.cjs` path is accepted (upstream required a `/`-prefixed one).
- The app-server is forked from the real `zcode.cjs` in its own directory — no symlinks, which need a privilege on Windows.
- The provider config the desktop materialised is picked up from `~/.zcode/v2/runtime/provider/windows-<cpu>/<version>/<endpoint>/zcode-builtin.json` (newest wins). When the desktop has never run, the config shipped with the install (`<ZCode>\resources\config\provider\zcode-builtin.json`) is copied to `~/.zcode-mcp\zcode-builtin.json` and used instead — the CLI itself never looks there on Windows.
- `scutil` (macOS system proxy) is only consulted on macOS.

Set `ZCODE_PROVIDER` to the account you actually logged in with (the default is `account:bigmodel-individual-coding-plan`; a Z.ai login is `account:zai-individual-coding-plan`):

```
claude mcp add zcode -s user -e ZCODE_PROVIDER=account:zai-individual-coding-plan -- node <repo>\dist\index.js
```

The ZCode desktop app does not have to be running, and never has to be launched again after the one-time login that writes `~/.zcode/v2/credentials.json`. The builtin provider revision required by `provider/updateAccountConfig` is derived locally (`zcode-builtin:<revision>:sha256(<absolute config path>)`) — it does not read desktop logs. Verified on ZCode 3.14.5 (2026-09-30 bundle) / Node 24.

## 接入配置

### Codex

`~/.codex/config.toml`(`<repo>` 替换为你克隆的绝对路径):

```toml
[mcp_servers.zcode]
command = "node"
args = ["<repo>/dist/index.js"]
```

> 注意:Codex 对 MCP 工具调用有自己的超时。真实开发任务动辄几分钟,建议调大工具超时;`zcode_run` 侧也有自己的 `timeout_ms` 参数(默认 10 分钟)。

### Claude Code / zcode 自身

```bash
claude mcp add zcode -- node <repo>/dist/index.js
# 或在任何支持 mcpServers 的客户端中等价配置
```

### 通用 mcpServers 片段

```json
{
  "mcpServers": {
    "zcode": {
      "command": "node",
      "args": ["<repo>/dist/index.js"]
    }
  }
}
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ZCODE_BIN` | `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` | zcode CLI 入口(绝对路径,`.cjs`) |
| `ZCODE_PROVIDER` | `account:bigmodel-individual-coding-plan` | 首选账号 provider |
| `ZCODE_MODEL` | `GLM-5.3` | 默认模型 |
| `ZCODE_REASONING` | `max` | 默认推理档位 |
| `ZCODE_DEFAULT_CWD` | server 进程 cwd | `zcode_run` 未传 `cwd` 时的兜底目录 |
| `ZCODE_MCP_AUTO_PROXY` | `1` | 自动检测 macOS 系统代理并透传给 zcode 子进程(`0` 关闭) |
| `ZCODE_MCP_DEBUG` | – | `1` 时向 stderr 输出调试日志 |
| `ZCODE_CREDENTIAL_SECRET` | 机器指纹派生 | zcode 凭据加密密钥(与 zcode 客户端一致,一般无需设置) |
| `ZCODE_ENTITLED_PROVIDERS` | from desktop log | comma list of account providers to mark entitled (overrides detection) |
| `ZCODE_CLIENT_VERSION` | newest `~/.zcode/v2/runtime/provider/<os>-<cpu>/<version>` | `clientVersion` of the project-token request |
| `ZCODE_TURN_GRACE_MS` | `600000` (10 min) | after a `zcode_run` times out, the turn may keep running this long, then it is stopped and its processes are killed (see "Process lifecycle") |
| `ZCODE_SESSION_IDLE_MS` | `1800000` (30 min) | an open session with no turn for this long is closed and its processes are killed (the session stays on disk) |
| `ZCODE_REAP_INTERVAL_MS` | `60000` | how often the idle / orphan sweep runs |
| `ZCODE_REAP` | `1` | `0` = never kill processes (sessions are still closed after each turn) |
| `ZCODE_PROJECT_MEMORY` | `0` | `1` = ZCode project memory for zcode-mcp sessions (reads `~/.zcode/cli/memories` and extracts new memories after each turn). Off because of the app-server crash below |

## Credentials (ZCode 3.15+ OAuth login)

ZCode 3.15 no longer stores a coding-plan api key. `~/.zcode/v2/credentials.json` (values
`enc:v1:...`, AES-256-GCM, key derived from the machine fingerprint) now holds:

| key | content (decrypted) |
|---|---|
| `oauth:active_provider` | `zai` or `bigmodel` |
| `oauth:<family>:access_token` | business-API login token (a JWT with `user_id` / `customer_id` claims) |
| `oauth:<family>:user_info` | `{user_id, email, name, avatar}` |
| `project-key-location:v1:<urlencoded [origin, family, user_id, null, 1, "non-team"]>` | `{organizationId, projectId, apiKeyId}` — one per account ever logged in |
| `zcodejwttoken`, `oauth:login_attribution` | not used here |

The key sent with model requests is a short-lived **project access token**, minted exactly as the
desktop host does it: `POST https://api.z.ai/api/biz/v1/organization/<org>/projects/<project>/api_keys/<apiKeyId>/access_tokens`
with `Authorization: Bearer <access_token>` and `{clientType: "zcode", clientVersion}` →
`{data: {enabled, accessToken, expiresIn (~4.8 h), expiresAt}}`. zcode-mcp answers
`interaction/requestProviderRuntimeHeaders` with `requestAuth: {apiKey: accessToken, apiKeyId}`
and caches the token until 2 min before expiry. The pointer of the *current* user (`user_info.user_id`)
is used; without one, the existing `zcode-api-key` of the personal default project is looked up
(read-only). If the stored token is rejected it is exchanged via `POST /api/auth/z/login` first.
The legacy format (`account-provider:coding-plan:<provider>:account:<id>:api-key`, ZCode ≤ 3.14)
is still read first.

Which account providers are entitled is decided by the account server, so it is taken from the
desktop host's last push to its own agent (`account provider config ... receivedRevision` in
`~/.zcode/v2/logs/*.log`); without that line the family's individual, start and off-peak plans are
assumed. `ZCODE_ENTITLED_PROVIDERS=<id,id>` overrides both. Model choice prefers `ZCODE_PROVIDER`,
then other providers, and **start plans last**: the desktop gates the free start plan behind an
interactive captcha (`X-Aliyun-Captcha-Verify-*`), so headless turns on it fail with
`Provider authentication failed`. Switching accounts in the desktop app needs no restart of the
MCP server for the key (it is re-read per request), but the entitlement push happens at boot.

## Process lifecycle

The app-server hosts every session inside its own process. What it spawns are direct children:
bash shells for the agent's commands (their command line carries
`~/.zcode/cli/exec/bash-startup/sess_<id>/...`), `__zcode-plugin-host` node processes and the stdio
MCP servers from `~/.zcode/cli/config.json` (e.g. `code-daemon-mcp.exe`). Every opened session —
including the throwaway ones used at boot and by `zcode_check` — gets its own plugin host and MCP
servers, and the app-server never stops them: not when a turn ends, not on `session/close`, and its
own idle unloading is disabled for sessions with a stream subscriber (which zcode-mcp always is).
Before this, a day of delegation left ~100 node processes (3.4 GB) behind.

What zcode-mcp does now:

- **After every `zcode_run`** (success, failure, error) the session is closed on the app-server
  (`session/close`) and its processes are killed. The session stays on disk: the next `zcode_run`
  with its `session_id` resumes it with full history (`session/resume` re-spawns what it needs).
- **Timed-out turns are not killed at once.** When `timeout_ms` expires the caller gets
  `turn timed out` together with the `session_id`, but the turn keeps running in the background —
  useful when zcode is about to commit. When it finishes on its own, the session is closed and
  reaped. If it is still running after `ZCODE_TURN_GRACE_MS` (default 10 min), it is stopped
  (`session/stop`) and reaped. A new `zcode_run` on that `session_id` stops the background turn
  first and then sends the new prompt.
- **Idle reaper**: every `ZCODE_REAP_INTERVAL_MS` open sessions without a turn for
  `ZCODE_SESSION_IDLE_MS` (default 30 min) are closed, and leftovers are swept.
- **On exit** (stdin closed by the MCP host, SIGTERM/SIGINT/SIGHUP, `process.exit`) the whole
  app-server tree is killed: `taskkill /T /F` on Windows; on macOS/Linux the app-server is forked
  as a process-group leader and the group plus every descendant gets SIGKILL.
- **Crash leftovers**: on boot, app-servers whose parent process is gone (a zcode-mcp that was
  SIGKILLed) are killed with their trees. App-servers with a live parent (the ZCode desktop app,
  other zcode-mcp instances) are never touched.

How a process is matched to a session: the processes are listed (`Get-CimInstance Win32_Process`
on Windows, `ps -A -o pid=,ppid=,rss=,etime=,command=` elsewhere) and only children of *this*
server's app-server are considered. A shell belongs to the session named in its `bash-startup`
path. Plugin hosts and MCP servers carry no session id (it is only in their environment, which
cannot be read portably), so they are matched by creation time: their candidate owners are all
sessions that were open on the app-server when they started (±3 s). A child is killed only when
**all** candidate owners are closed, so with several concurrent sessions a shared one survives
until the last of them closes. Children no open session explains are killed only when no session
is open at all (and they are older than 10 s). The app-server's own `conhost.exe` is never touched.

**When the app-server dies.** All sessions of a zcode-mcp instance live in one app-server, so
its death interrupts every running turn. Each of them gets
`zcode turn FAILED: app-server died (exit N) with K open session(s) ... Last app-server error: ...`
plus its `session_id`; the next `zcode_run` boots a new app-server, and the session continues by
`session_id` (history is on disk). The app-server writes uncaught errors only to stderr, which
zcode-mcp now always appends to `~/.zcode-mcp/logs/app-server-<date>.log` (`[pid]` per line), so
the cause of an `exit 1` can be found afterwards. Reaping never targets the app-server itself:
closing one session kills only children no open session can own, and the app-server tree is
killed only on zcode-mcp exit.

**Known ZCode issue: closing a session can kill the app-server (ZCode 3.15.3).** With project
memory on, the end of every turn schedules a background `project_memory_extract` (its own model
request) about 0.7 s later. `session/close` runs `beginShutdown()` *before* draining that
extraction, so the request is aborted at once. When the abort lands while the request is being
prepared (13–40 ms after it started: all four crashes of 15.10.2026; 22 cancellations at 0–12 ms or
≥ 246 ms were harmless), a promise inside ZCode rejects with that `AbortError` and nobody handles it:
`unhandledRejection` → `requestShutdown("Uncaught process error")` → every session's turn is
cancelled and the app-server exits 1. Stack in `app-server-<date>.log`:
`AbortController.abort ← Object.shutdown (memory extraction scheduler) ← uD.beginShutdown ← close ←
closeSession`; in `~/.zcode/cli/log/zcode-<date>.jsonl` the closed session's last events are
`model.request.failed` / `model.retry.delay.resolved` with `querySource: project_memory_extract`.
zcode-mcp therefore answers `session/requestRuntimePreferences` with `memoryEnabled: false`
(unless `ZCODE_PROJECT_MEMORY=1`): the session runtime gets `memory.enabled=false`, no extraction
is ever scheduled, and closing a session right after its turn has nothing to abort.

TODO: the stdio MCP servers of `~/.zcode/cli/config.json` (e.g. code-daemon) are spawned for every
zcode-mcp session too, and an app-server may die when one of them is killed from outside (seen
around rebuilds of code-daemon, not proven). The app-server has no per-session MCP switch; the
only knob is `ZCODE_HOME`, which would also move the session database. A separate config for
zcode-mcp sessions would need that split first.

`zcode_check` sweeps once and reports the tree, e.g.
`processes: app-server pid 30100 + 2 children (code-daemon-mcp.exe×1, conhost.exe×1), 223 MB total; open sessions: 0, running turns: 0 (in grace: 0); reaped now: 4`.

## 工作原理(逆向笔记)

zcode 桌面版并不直接跑 agent,而是 spawn `zcode app-server` 子进程,通过一套内部协议(ZCode Protocol)交互。本工具在 MCP 侧重演了"桌面客户端"的角色:

- **传输**:stdio 上的行分隔 JSON(注意:不是 JSON-RPC,带 `jsonrpc` 键会被严格 zod 校验拒绝)。
- **provider 物化**:app-server 自身不持有账号 provider。桌面版启动时通过 `provider/updateAccountConfig` 推送 provider 定义(不带密钥),并在每次模型请求时响应 `interaction/requestProviderRuntimeHeaders` 注入凭据。zcode-mcp 读取 `~/.zcode/v2/credentials.json` 中加密的 coding-plan api-key(AES-256-GCM,密钥由机器指纹派生)完成同样的事。
- **启动就绪**:app-server 对 `provider/updateAccountConfig` 先应答、后应用;若推送带的 `basedOnZCodeBuiltinRevision` 与子进程解析到的 builtin 配置不一致,推送会被**静默丢弃**(所有 provider 保持 fail-closed、模型列表为空)。zcode-mcp 按确定性公式在本地推导该 revision,并在推送后轮询 `session/read`(其 `settings.model.available` 每次调用都按当前可用性重算)直到模型出现——凭据缺失时立即判定并明确报告,因此冷启动后的第一次 `zcode_run`/`zcode_check` 不会再撞上空模型列表。
- **会话**:`session/create`(可带 mode/model)→ `session/subscribe` → `session/send`(带 `modelSelection`,含必填的 `reasoningLevel`)→ 收 `session/event` 通知直到 `turn.completed`/`turn.failed` → `session/messages` 取结构化结果(答复文本、工具调用、token 用量)。
- **TLS/代理**:Node 内置 CA 库缺 api.z.ai 的 Sectigo 新证书链;首次启动会把 macOS 系统根证书导出到 `~/.zcode-mcp-system-roots.pem` 并以 `NODE_EXTRA_CA_CERTS` 传给子进程。若设置了系统代理,也会自动以 `HTTPS_PROXY` 透传(zcode 原生支持)。
- **进程隔离**:zcode 入口脚本被软链到 `~/.zcode-mcp/zcode-entry.cjs`,子进程以固定相对路径 fork,不拼接任何动态命令。

## 安全须知

- `zcode_run` 等于把**本机代码执行权**交给调用方 agent(默认 `yolo` 模式,无确认直接执行)。只在你信任的 MCP 客户端里加载。
- 需要更保守时用 `mode: "plan"`(只读分析)或 `"build"`;app-server 上抛的权限确认(`interaction/*`)会被自动拒绝,任务即失败返回,不会挂起。
- 凭据只在本地解密并直传给本机的 zcode 子进程,不落盘、不出网。

## 开发

```bash
npm run build        # 编译到 dist/
node scripts/probe.mjs "..."       # 直接驱动 app-server 协议(逆向用)
node scripts/probe-fork.mjs        # fork 模式事件流对照实验
node scripts/race_probe.mjs [N]    # 冷启动竞态探针:全新子进程首次查询模型列表是否为空
node scripts/fresh-home-probe.mjs  # 桌面独立性实验:全新 HOME 下 app-server 能否找到 builtin 配置
node scripts/e2e.mjs               # 端到端:起 MCP server,跑 zcode_check/zcode_run/追问/会话列表
npm test                           # unit tests + live tests (boot a private app-server; ZCODE_SKIP_LIVE=1 skips the turn-spending one)
```

### 已知限制

- ZCode Protocol 是内部接口,随 zcode 版本(当前验证 0.16.9)可能变动;协议层全部隔离在 `src/protocol.ts`,变动时只需改这一个文件。
- 权限确认交互被自动拒绝,因此 `build`/`edit` 模式下需要确认的操作会失败——无头委派场景建议 `yolo`。
- 模型列表按工作区缓存,但**空列表永不缓存**(空列表是启动竞态的产物,不是账号事实);`start()` 完成前会等 app-server 真正暴露模型(最多 10 s)。切换 zcode 登录账号需重启 MCP server;若后端开始拒绝凭据(模型请求报鉴权错误),在桌面版重新登录一次并重启本 server——api-key 本身无可读的过期时间,无法提前检测。

## License

[MIT](./LICENSE)
