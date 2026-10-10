# SassDesk 安全说明（v0.1.0）

## 威胁模型

SassDesk 的核心风险：**不可信的模型输出驱动本机副作用**。LLM 可能被提示词注入、幻觉或用户误表达引导，生成危险操作。因此所有安全边界都放在**宿主程序侧**（代码），不依赖模型自律。

## 控制措施

### 1. 工具白名单（代码即固件）
- 模型只能调用 `ToolRegistry` 中注册的工具；未注册工具在 `beforeToolCall` 层直接拒绝。
- 白名单注册在源码 `bootstrap.ts` / `apps.ts` 中，模型无法在运行时修改。
- 任意文件删除、任意命令执行、关闭安全软件、网络下载执行等能力**不存在于工具集中**。

### 2. 启动链路收口
- `process_start` 只接受 `appId`（枚举），路径解析走「用户配置 → 常见路径 → 注册表 Uninstall 键」三步，全部校验文件存在。
- 不存在「模型给一个 exe 路径就执行」的通道：相对路径被 `ChildAppLauncher` 拒绝。
- PowerShell 执行封装固定 `-NoProfile -NonInteractive`，脚本由**代码**构造，参数经转义（单引号 doubling），模型不可注入。

### 3. 授权门（Approval Gate）
| 级别 | 行为 | 例子 |
|---|---|---|
| `safe` | 直接执行 | 进程查询、环境信息、规则列表 |
| `confirm` | 用户 y/n 确认（展示参数摘要） | 启动应用、保存规则、手动执行规则 |
| `startup-auth` | 同 confirm（额外说明开机启动影响） | rule_enable |

- 非交互环境（无 TTY/无 handler）默认**拒绝**非 safe 工具。
- 规则状态机强制：`saveDraft` 恒为 `enabled=false`；`enable` 必须带 `authorized` 且 startup 规则必须记录授权时间——即使模型越级调用也无法绕过。

### 4. 凭证与隐私
- API Key 来源优先级：env（`SASSDESK_API_KEY` / `<PROVIDER>_API_KEY`）> `config.local.json`（gitignored）。**绝不入库、绝不打印**：pino `redact` 覆盖 `apiKey/token/authorization` 等字段。
- 语音：`sapi` 本地识别（音频不出本机）；`whisper` 云端转写（CLI 触发前明确提示上传行为）；`mock` 显式标注模拟。
- 日志不记录对话原文（只记录事件与工具元数据）；`data/`、`logs/`、`*.wav` 均在 `.gitignore`。

### 5. 失败与重试
- 工具超时（默认 15s）与任务级迭代上限（`llm.maxIterations`，默认 8 轮）由宿主强制，防止无限自修复循环。
- 被拒绝的工具调用以 `isError` 工具结果回传模型，并要求其如实告知用户「未执行」。

## 已知残留风险

1. **提示词注入经工具结果**：工具返回内容会进入模型上下文。当前工具集的输出均为结构化元数据，风险低；未来接入读文件/网页类工具时需对内容做隔离标注。
2. **白名单应用本身的副作用**：启动 QQ 音乐等白名单应用后，应用内部行为（如自动续播）不受 SassDesk 控制。
3. **HKCU 启动项可被同权限软件修改**：这是 Windows 用户级启动机制的固有限制；`/startup` 与 `startup_status` 工具可随时核对实际状态。
4. **注册表 Uninstall 探测**依赖 DisplayName 关键字匹配，恶意软件若伪造 DisplayName 可能误导路径解析——但最终仍需通过「目标 exe 存在性」校验，且仅限白名单 app 的固定 exe 名。

## 上报

发现安全问题请开 issue 并标注 `security`，勿公开可利用细节。
