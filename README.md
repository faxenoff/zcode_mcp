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
| `zcode_run` | 委派一个开发任务给 zcode。参数:`prompt`(必填)、`cwd`(项目目录)、`mode`(plan/build/edit/yolo,默认 yolo)、`model`(默认 GLM-5.3)、`reasoning_level`(low/high/max)、`session_id`(续接上一轮)、`timeout_ms`(默认 10 分钟,上限 1 小时)。返回 zcode 的最终答复 + `session_id` + 工具使用/token/耗时统计 |
| `zcode_check` | 检查后端可用性:二进制路径、凭据、可用模型列表 |
| `zcode_sessions` | 列出某工作区的最近会话(可作为 `session_id` 续接) |

## 前置条件

1. **ZCode 桌面版**(macOS)已安装,且**登录过一次**——登录凭据存放在 `~/.zcode/v2/credentials.json`,zcode-mcp 复用它们,无需再次登录。
2. Node.js ≥ 18。
3. 构建本工具:
   ```bash
   git clone https://github.com/TechYan/zcode_mcp.git
   cd zcode_mcp
   npm install && npm run build
   ```

## Windows (this fork)

Upstream is macOS-only. This fork (faxenoff/zcode_mcp) makes the same code run on Windows:

- `ZCODE_BIN` defaults to `%LOCALAPPDATA%\Programs\ZCodeesources\glm\zcode.cjs`; any absolute `.cjs` path is accepted (upstream required a `/`-prefixed one).
- The app-server is forked from the real `zcode.cjs` in its own directory — no symlinks, which need a privilege on Windows.
- The provider config the desktop materialised is picked up from `~/.zcode/v2/runtime/provider/windows-<cpu>/<version>/<endpoint>/zcode-builtin.json` (newest wins), the way the macOS branch reads it through `plutil`.
- `scutil` (macOS system proxy) is only consulted on macOS.

Set `ZCODE_PROVIDER` to the account you actually logged in with (the default is `account:bigmodel-individual-coding-plan`; a Z.ai login is `account:zai-individual-coding-plan`):

```
claude mcp add zcode -s user -e ZCODE_PROVIDER=account:zai-individual-coding-plan -- node <repo>\dist\index.js
```

The ZCode desktop app does not have to be running; it only has to have logged in once. Verified on ZCode 0.16.9 / Node 24.

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

## 工作原理(逆向笔记)

zcode 桌面版并不直接跑 agent,而是 spawn `zcode app-server` 子进程,通过一套内部协议(ZCode Protocol)交互。本工具在 MCP 侧重演了"桌面客户端"的角色:

- **传输**:stdio 上的行分隔 JSON(注意:不是 JSON-RPC,带 `jsonrpc` 键会被严格 zod 校验拒绝)。
- **provider 物化**:app-server 自身不持有账号 provider。桌面版启动时通过 `provider/updateAccountConfig` 推送 provider 定义(不带密钥),并在每次模型请求时响应 `interaction/requestProviderRuntimeHeaders` 注入凭据。zcode-mcp 读取 `~/.zcode/v2/credentials.json` 中加密的 coding-plan api-key(AES-256-GCM,密钥由机器指纹派生)完成同样的事。
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
node scripts/e2e.mjs               # 端到端:起 MCP server,跑 zcode_check/zcode_run/追问/会话列表
```

### 已知限制

- ZCode Protocol 是内部接口,随 zcode 版本(当前验证 0.16.9)可能变动;协议层全部隔离在 `src/protocol.ts`,变动时只需改这一个文件。
- 权限确认交互被自动拒绝,因此 `build`/`edit` 模式下需要确认的操作会失败——无头委派场景建议 `yolo`。
- 每个工作区首次 `session/create` 后模型列表会缓存;切换 zcode 登录账号需重启 MCP server。

## License

[MIT](./LICENSE)
