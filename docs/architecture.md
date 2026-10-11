# SassDesk 架构设计（v0.1.0）

## 总览

SassDesk 是运行在 Windows 上的个人 AI 员工（v0.1.0 形态为 CLI）。核心循环：

```
用户输入（文本 / 语音→STT→文本）
→ Agent 结合会话与用户偏好理解意图（普通问答 / 即时任务 / 需保存的自动化规则）
→ 生成结构化任务计划（通过工具调用表达）
→ 检查工具权限与参数（TypeBox 校验 + 白名单）
→ 缺失信息则向用户追问；需授权操作弹确认（beforeToolCall 授权门）
→ 执行工具（超时/取消受控）
→ 验证实际结果（如：进程存在 ≠ 音乐播放成功）
→ 汇总执行状态并反馈
```

模型负责语义理解与任务决策；程序负责权限控制、参数校验和真实执行；用户偏好不替代操作授权。

## 三层依赖（自底向上，禁止反向依赖）

```
┌─────────────────────────────────────────────────────┐
│ 第三层 Application  src/app/**                       │
│  CLI REPL / 斜杠命令 / 偏好 / 自动化规则 / 语音管线     │
│  角色配置 / QQ 音乐启动器 / Windows Startup Provider   │
│  JSON 存储（接口化，可替换）                           │
├─────────────────────────────────────────────────────┤
│ 第二层 Agent Core   src/agent/**                     │
│  SassDeskAgent：封装 pi-agent-core 的 Agent 类        │
│  工具注册表（TypeBox 参数校验 + 超时包装）              │
│  beforeToolCall 授权门（敏感工具 → 用户确认）           │
│  finishTurn 迭代上限 / AbortController 超时           │
│  事件桥（agent 事件 → CLI 可读输出）                   │
├─────────────────────────────────────────────────────┤
│ 第一层 Runtime & LLM  src/runtime/**                 │
│  llm: pi-ai 薄适配（provider/模型/APIKey 解析）        │
│  config: TypeBox 配置 schema + env + config*.json    │
│  logging: pino 结构化日志（敏感字段脱敏）               │
└─────────────────────────────────────────────────────┘
外部依赖（仅第一、二层可见）：@earendil-works/pi-ai、@earendil-works/pi-agent-core
```

规则：

- 第三层只能 import 第一、二层；第二层只能 import 第一层；第一层不 import 任何上层。
- `src/agent/**` 与 `src/runtime/**` 不得出现 QQ 音乐、开机启动、语音等产品逻辑。
- 工具以普通函数 + 注册表方式进入 Agent，注册发生在第三层（CLI 启动时组装），核心不感知具体业务。

## 关键设计决策

1. **直接依赖 Pi，不 fork**：`@earendil-works/pi-agent-core@^1.1.0` + `@earendil-works/pi-ai@^1.1.0`（均为 MIT）。详见 `docs/pi-analysis.md`。
2. **TypeBox 一套 schema 走天下**：pi 生态的工具参数原生就是 TypeBox，SassDesk 的配置校验也用 TypeBox（`Value.Check/Value.Default`），避免引入第二套 schema 库（即"Zod 或同类方案"选型中的"同类方案"，理由：与 Agent 工具 schema 同源，减少依赖与转换层）。
3. **授权门（Approval Gate）**：`Agent` 构造的 `beforeToolCall` 钩子统一实现——工具注册时声明 `dangerLevel: "safe" | "confirm" | "startup-auth"`；`confirm` 级工具在执行前经 CLI 询问用户 y/n（含参数摘要）；`startup-auth` 级额外要求规则级授权记录。模型无法跳过，因为钩子在宿主程序侧。
4. **成功判据显式化**：进程启动工具返回"命令已发送 + 进程已出现"两级事实；QQ 音乐工具明确区分 `launched`（客户端已启动、进程存在）与"指定歌曲播放"——后者 v0.1.0 不承诺（QQ 音乐无公开本地播放控制 API），反馈用语如实。
5. **可注入系统适配器**：进程操作、注册表、文件系统都收敛在 `app/system/**` 的接口后面，测试注入 fake/mocked 实现，绝不真实改动用户启动项或自动操作 QQ 音乐。
6. **存储接口化**：`JsonStore`（原子写、临时目录注入）支撑偏好与规则，未来可替换 SQLite/云同步而不动上层。

## 目录结构

```
D:\SassDesk\
├─ src/
│  ├─ index.ts                  # 入口：解析 --run-startup 等参数，组装三层
│  ├─ runtime/                  # 第一层
│  │  ├─ config/                # 配置 schema + 加载（env > config.local.json > config.json）
│  │  ├─ llm/                   # pi-ai 适配：Models 工厂、模型解析、中文问答
│  │  └─ logging/               # pino 封装
│  ├─ agent/                    # 第二层
│  │  ├─ core/                  # SassDeskAgent 封装 + 事件桥
│  │  └─ tools/                 # 注册表、授权门、系统/音乐/规则工具
│  ├─ app/                      # 第三层
│  │  ├─ cli/                   # REPL、斜杠命令、渲染
│  │  ├─ preferences/           # 用户偏好
│  │  ├─ automation/            # 规则 CRUD、状态机、开机执行器
│  │  ├─ voice/                 # Recorder/SttProvider 接口 + mock/sapi/whisper 实现
│  │  ├─ characters/            # 角色配置（默认"Sass"）
│  │  ├─ music/                 # QQ 音乐启动器与状态
│  │  ├─ system/                # process / windows / startup（可注入适配器）
│  │  └─ storage/               # JsonStore
│  └─ shared/                   # 错误类型、路径
├─ tests/{unit,integration,fixtures}/
├─ docs/{architecture,pi-analysis,security,development,roadmap}.md
├─ assets/characters/           # 角色占位图
├─ config.example.json          # 不含密钥的配置示例
└─ .env.example                 # 环境变量示例
```

## 配置体系

优先级：环境变量 > `config.local.json`（gitignored，放 API Key）> `config.json` > 内置默认。

```jsonc
// config.example.json
{
  "llm": {
    "provider": "openai",           // openai | anthropic | deepseek | moonshot | zai | openai-compatible ...
    "model": "gpt-4o-mini",
    "baseUrl": "",                   // 仅 openai-compatible 需要
    "apiKey": "",                    // 留空则读 env：SASSDESK_API_KEY 或 <PROVIDER>_API_KEY
    "maxIterations": 8,              // 单次任务最大工具轮数
    "requestTimeoutMs": 120000
  },
  "voice": { "provider": "mock" },   // mock | sapi | whisper
  "music": { "qqmusicPath": "" },    // 留空自动探测常见安装位置
  "character": { "name": "Sass" },
  "logging": { "level": "info", "dir": "logs" }
}
```

## 安全边界

- 工具白名单内置于注册表；模型只能调用已注册工具，不能生成任意 PowerShell/Shell 并执行——进程启动一律走「白名单应用名 → 已验证路径 → 受控子进程」链路。
- 任意文件删除、任意命令执行、关闭安全软件等能力**不提供**。
- API Key 只从 env / config.local.json 读取，日志脱敏（`apiKey`、token 字段），`.gitignore` 排除密钥/音频/日志/私有配置。
- 开机启动仅写 HKCU Run（无需管理员），可查询/开启/关闭/幂等去重，规则必须有 `enabled` 开关。

## 已知限制（v0.1.0）

- QQ 音乐"播放指定歌曲"无官方公开本地接口，v0.1.0 交付可靠的客户端启动 + 进程验证，反馈如实区分。
- 语音 STT 依赖可用性：`sapi` 需系统装有中文识别引擎；`whisper` 需外部 API；`mock` 仅测试。
- 持续监听、唤醒词、桌面悬浮窗均不在本期范围。
