# SassDesk

基于 [Pi Agent](https://github.com/earendil-works/pi)（`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`，MIT）的个人桌面 AI 员工，运行在 Windows 10/11 上。v0.1.0 形态为 **CLI**。

你用中文告诉它要做什么（文本或语音转文本），它理解意图、调用经过授权的系统工具、验证真实结果并如实反馈。

```
大肥鱼> 现在打开 QQ 音乐
⚙ 执行工具 qqmusic_start …
✓ qqmusic_start 完成（2143ms）
QQ 音乐客户端已启动（C:\...\QQMusic.exe，pid: 12345）。注意：这只代表客户端已运行……
```

## 功能（v0.1.0）

- **中文多轮对话**：基于 Pi Agent Loop（流式输出、工具调用、可取消、迭代上限）
- **受控系统工具**：环境信息、进程查询、白名单应用启动（模型接触不到任何 shell 命令）
- **QQ 音乐**：可靠启动客户端并确认进程出现；明确区分「命令已发送」与「进程已确认」；**不支持**自动播放指定歌曲（QQ 音乐无公开本地播放接口，如实报告）
- **自动化规则**：创建草稿 → 用户确认 → 保存 → 明确启用 → 开机自动执行 → 结果审计（JSONL）
- **开机启动**：HKCU Run 注册表（无需管理员），可查询/注册/撤销，幂等，随时停用
- **语音输入**（P1）：按键录音 → STT → 确认 → 与文本同入口；Provider：`mock` / `sapi`（本地识别，音频不出本机）/ `whisper`（云端转写，音频会上传）
- **角色配置**：默认角色「大肥鱼」，可换名、换风格、预留状态资源路径（悬浮窗留待 v0.2.0）

## 环境要求

- Windows 10/11
- Node.js **≥ 22.19**
- 一个 LLM API Key（OpenAI / Anthropic / DeepSeek / Moonshot / ZAI / Gemini / OpenRouter / 任意 OpenAI 兼容端点）

## 安装与运行

```powershell
# 1. 安装依赖
cd D:\SassDesk
npm install

# 2. 配置模型（三选一）
#    方式一：环境变量
setx SASSDESK_API_KEY "sk-你的Key"
#    方式二：复制 .env.example 为 .env 并填写 SASSDESK_API_KEY
#    方式三：创建 config.local.json（不会被提交）：
#      { "llm": { "apiKey": "sk-你的Key" } }

# 3. 如需指定 provider/模型，编辑 config.json（完整字段见 config.example.json）
#    例如 DeepSeek：{ "llm": { "provider": "deepseek", "model": "deepseek-chat" } }
#    例如任意 OpenAI 兼容端点：
#    { "llm": { "provider": "openai-compatible", "model": "模型名", "baseUrl": "https://api.example.com/v1" } }

# 4. 启动
npm run build
npm start
```

常用命令：

| 命令 | 说明 |
|---|---|
| `npm start` | 启动 CLI |
| `npm run startup-run` | 开机执行模式：运行所有已启用的开机规则后退出 |
| `npm test` | 运行全部测试（58 例，不触碰真实系统） |
| `npm run typecheck` | TypeScript 严格类型检查 |
| `npm run build` | 构建到 dist/ |

## CLI 内置命令

```
/help                帮助
/rules               查看自动化规则
/startup             查看开机启动状态
/voice               按键录音并识别（voice.provider=sapi 时为本地识别；mock 仅演示）
/voice-file <路径>    用 Whisper 兼容服务转写音频文件（音频会上传到配置的服务）
/prefs               查看音乐偏好
/quit                退出
```

Ctrl+C：任务运行中=取消当前任务；空闲时按两次=退出。

## 端到端演示（QQ 音乐任务）

```text
大肥鱼> 以后每次开机后，自动帮我打开 QQ 音乐

（Agent 判断这是自动化规则 → 生成结构化方案并保存草稿）
⚙ 执行工具 rule_save …
规则已保存（草稿，未启用）：规则「开机播放 QQ 音乐」…不会自动执行

（Agent 询问是否启用）
⚠ 需要你的确认 ──────────────────────
即将执行【启用自动化规则】（rule_enable），该操作会修改开机启动配置。
参数：{"name":"开机播放 QQ 音乐"}
允许执行吗？(y=同意 / 其他=拒绝) > y

规则「开机播放 QQ 音乐」已启用（用户已确认授权）。
已注册 Windows 开机启动项「SassDeskStartup」→ "node.exe" "D:\SassDesk\dist\index.js" --run-startup …

大肥鱼> /startup
开机启动：已注册 → "C:\...\node.exe" "D:\SassDesk\dist\index.js" --run-startup

大肥鱼> 现在先打开一次试试
⚙ 执行工具 qqmusic_start …
QQ 音乐客户端已启动（...，pid: 8901）。注意：这只代表客户端已运行，不代表已开始播放任何歌曲。
（说明：QQ 音乐没有公开的本地播放控制接口，无法保证自动播放指定歌曲/歌单。）
```

下次登录 Windows 时，SassDesk 会以 `--run-startup` 自动运行并执行该规则，结果记录在 `data/executions.jsonl`。随时可以：
- 对它说「停用开机播放 QQ 音乐」（撤销注册表启动项）
- 或在任务管理器 → 启动应用里禁用 `SassDeskStartup`

## 项目结构

```
src/
├─ runtime/    第一层：LLM 适配(pi-ai)、配置(TypeBox)、日志(pino)
├─ agent/      第二层：Agent 封装、工具注册表、授权门、事件桥、系统提示词
├─ app/        第三层：CLI、规则、偏好、QQ 音乐、系统适配器(PowerShell/进程/启动项)、语音、角色、存储
└─ shared/     错误体系与路径
tests/         单元 + 集成测试（faux LLM、fake 系统适配器，不触碰真实系统）
docs/          architecture / pi-analysis / security / development / roadmap
```

三层依赖方向严格自底向上：`app → agent → runtime`，底层不 import 业务模块。详见 [docs/architecture.md](docs/architecture.md)。

## 安全模型

- 模型只能调用**代码内注册**的工具；进程启动必须走「appId → 白名单 → 已验证路径」链路，无法执行任意命令
- 工具按风险分级：`safe`（只读）直接执行；`confirm`（有副作用）需用户 y/n 确认；`startup-auth`（改开机启动）同样需要确认，规则级授权落盘记录
- API Key 只从环境变量 / `config.local.json`（已 gitignore）读取，日志统一脱敏
- 开机启动仅写 `HKCU\...\Run`（用户级、无需管理员、透明可撤销）
- 完整说明见 [docs/security.md](docs/security.md)

## 已知限制（如实声明）

1. **QQ 音乐播放控制**：只能可靠启动客户端并确认进程，无法自动播放指定歌曲/歌单
2. **真实模型调用验收**：本项目开发环境无 API Key，所有 LLM 交互测试使用官方 `fauxProvider`（假模型）覆盖 Agent Loop 逻辑；配置真实 Key 后的调用路径与 faux 相同（同一 `streamSimple` 入口），但请在你自己的环境完成一次真实问答验收
3. **SAPI 语音识别**：需要系统安装中文语音识别引擎（设置 → 时间和语言 → 语音）；缺失时 CLI 会给出明确提示
4. 不含持续监听、唤醒词、桌面悬浮窗（v0.2.0 方向）

## 许可证

MIT。依赖的 [Pi Agent](https://github.com/earendil-works/pi)（`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`）同为 MIT。
