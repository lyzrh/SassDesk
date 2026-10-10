# Pi Agent 源码分析（SassDesk 前置研究）

> 研究对象：`earendil-works/pi`（GitHub，前身为 badlogic/pi-mono），MIT 许可证。
> 本文所有 API 均以 npm 上发布的 `@earendil-works/pi-ai@1.1.0` 与 `@earendil-works/pi-agent-core@1.1.0` 的官方 README 及安装后的 `.d.ts` 类型定义为准，未包含臆造接口。

## 0. 仓库概况

| 项 | 内容 |
|---|---|
| 仓库 | https://github.com/earendil-works/pi |
| 定位 | "AI agent toolkit: unified LLM API, agent loop, TUI, coding agent CLI" |
| 许可证 | **MIT**（允许复用、修改、分发，需保留版权与许可声明） |
| 语言/运行时 | TypeScript，Node.js ≥ 22.19，npm workspaces |
| 相关包 | `@earendil-works/pi-ai`（统一 LLM API）、`@earendil-works/pi-agent-core`（Agent 运行时）、`@earendil-works/pi-coding-agent`（编码 CLI）、`@earendil-works/pi-tui`（终端 UI）、`@earendil-works/pi-durable` 等 |

## 1. Pi 的最底层如何调用 LLM？

由 `@earendil-works/pi-ai` 承担。1.1.0 起 API 围绕 **Models 集合**组织：

```ts
import { createModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

const models = builtinModels();          // 注册所有内置 provider（OpenAI/Anthropic/Google/DeepSeek/Moonshot/ZAI/...）
const model = models.getModel("openai", "gpt-4o-mini")!;
const stream = models.streamSimple(model, context, { reasoning: "low" }); // 统一流式入口
const message = await models.completeSimple(model, context, { reasoning: "medium" }); // 非流式
```

- 4 个公开入口：`stream / streamSimple / complete / completeSimple`。
- 内置 provider 自带 API Key 解析：**显式 options.apiKey > CredentialStore > 环境变量**（如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY`、`MOONSHOT_API_KEY`、`ZAI_API_KEY` 等）。
- 支持任意 OpenAI 兼容端点（自定义 baseUrl，可用于 DeepSeek/智谱/本地 Ollama 等）。
- 无自动重试；流式失败不抛异常，以 `error` 事件和 `stopReason: "error" | "aborted"` 报告（缺凭证时 `streamSimple` 同步抛错）。

## 2. 消息、上下文和模型响应如何流转？

```ts
interface Context {
  systemPrompt?: string;
  messages: Message[];   // user / assistant / toolResult（content 可为字符串或内容块数组）
  tools?: Tool[];
}
```

流转链路（Agent 类）：

```
AgentMessage[]（SassDesk 会话记录）
  → transformContext()（可选，裁剪/压缩上下文）
  → convertToLlm()（必需，过滤出 LLM 认识的角色）
  → Message[] → pi-ai → AssistantMessage（content 块: text / thinking / toolCall；带 stopReason、usage、cost）
  → 若 stopReason === "toolUse"：执行工具，toolResult 消息追加，进入下一轮
  → 否则本轮结束
```

`AssistantMessage.stopReason` 取值：`"pending" | "stop" | "length" | "toolUse" | "error" | "aborted"`。

## 3. Agent Loop 如何判断继续执行工具还是结束任务？

- 模型响应的 `stopReason === "toolUse"` → 发起工具执行批次 → 工具结果写回上下文 → 再调用一次 LLM；
- `stopReason === "stop" | "length"` 等 → 结束本轮；
- `finishTurn` 钩子可在 `turn_end` 前返回 `{ action: "continue" }` 强制继续、`{ action: "end" }` 强制结束（可用来实现**最大迭代次数**等自定义停止条件）；
- 错误与 aborted 是硬退出，`finishTurn` 的决策会被忽略。

## 4. 工具调用、参数验证、执行结果返回分别在哪里处理？

```ts
const myTool: AgentTool = {
  name: "read_file",
  label: "Read File",
  description: "Read a file's contents",
  parameters: Type.Object({ path: Type.String({ description: "File path" }) }), // TypeBox schema，即 LLM 的 JSON Schema
  execute: async (toolCallId, params, signal, onUpdate) => {
    return { content: [{ type: "text", text: "..." }], details: { path: params.path } };
  },
};
```

- **参数 schema**：`AgentTool.parameters` 使用 TypeBox（`typebox` 包的 `Type`），同时作为发给 LLM 的工具 JSON Schema；
- **参数验证**：`validateToolCall(tools, toolCall)`（pi-ai 导出），参数不合法时抛错；SassDesk 在工具注册表层再加一道校验；
- **执行**：`execute(toolCallId, params, signal, onUpdate)`，`onUpdate` 可上报中间进度；
- **结果**：返回 `{ content, details }`；**错误应抛异常**，Agent 会转成 `isError: true` 的 toolResult 反馈给 LLM；
- **授权/干预钩子**：`beforeToolCall({ toolCall, args, context })` 可返回 `{ block: true, reason, terminate }` 拦截调用；`afterToolCall` 可覆盖结果。这是 SassDesk 实现"敏感操作需用户确认"的挂载点。

## 5. 流式事件如何传递给上层？

`agent.subscribe(async (event, signal) => {...})` 订阅事件流；`await agent.prompt(text)` 结束时事件已全部送达。

事件类型：`agent_start` / `turn_start` / `message_start` / `message_update`（仅 assistant，含 `assistantMessageEvent` delta，如 `text_delta`）/ `message_end` / `tool_execution_start` / `tool_execution_update` / `tool_execution_end` / `turn_end` / `agent_end`。

低层 `agentLoop()` 也可用 `for await (const event of agentLoop(...))` 消费，但低层流是观察性的（无 barrier 语义），SassDesk 使用 `Agent` 类。

## 6. 异常、取消、超时和模型调用失败如何处理？

- **取消**：`agent.abort()`；各钩子与工具 `execute` 均收到 `AbortSignal`；
- **工具错误**：工具内 throw → Agent 转为 `isError` toolResult 回传 LLM（LLM 可据此重试/汇报）；
- **模型调用失败**：不抛异常（凭证缺失除外），经 `error` 事件 + `stopReason: "error"` 报告，`usage` 仍含已消耗部分；
- **超时**：Pi 本身不带任务级超时，需要上层实现——SassDesk 用 `AbortController + setTimeout` 包装工具执行与整轮运行（见 `src/agent/core/sassdesk-agent.ts`）。

## 7. 哪些模块直接复用，哪些由 SassDesk 自行实现？

**直接复用（npm 依赖，不 fork）：**
- `@earendil-works/pi-ai`：多 provider LLM 调用、流式、token/成本统计、凭证解析；
- `@earendil-works/pi-agent-core`：`Agent` 类（loop、steering/followUp 队列、事件流、工具执行编排、beforeToolCall/afterToolCall 钩子）。

理由：这两者正是"Agent Runtime 的发动机"，自研无收益且难保证多 provider 正确性；MIT 允许直接依赖。

**SassDesk 自行实现：**
- 配置加载与校验（TypeBox + env）、结构化日志（pino）；
- 受控系统工具（进程查询/白名单启动/QQ 音乐）与授权确认 UX；
- 自动化规则、偏好、JSON 存储、Windows Startup Provider；
- 语音管线与 STT Provider 接口、角色配置、CLI REPL；
- 最大迭代/超时控制（挂在 `finishTurn` 与工具包装层）。

**不引入**：`pi-coding-agent`（面向编码场景的 CLI，与 SassDesk 定位不同）、`pi-tui`（v0.1.0 只需 readline REPL）、`pi-durable`（本地 JSON 文件足够）。

## 8. 许可证是否允许预期复用与分发方式？

**MIT**：允许商业/私有用途、复制、修改、再分发、再授权，唯一要求是在副本中保留版权与许可声明。SassDesk 以 npm 依赖方式使用（不修改上游代码），在 README 中注明依赖及其许可证即可，完全满足当前复用与分发方式。

## 9. 与 SassDesk 三层架构的映射

| SassDesk 层 | 承担者 | 与 Pi 的关系 |
|---|---|---|
| 第一层 Runtime & LLM | `src/runtime/llm` | 薄适配层：封装 `createModels/builtinModels/getModel`，解析 SassDesk 配置 → pi-ai 的 model/apiKey；上层不直接 import pi-ai |
| 第二层 Agent Core | `src/agent/core` | 封装 `Agent`：注入 systemPrompt（角色风格 + 工具使用规则）、`streamFn: models.streamSimple.bind(models)`、`beforeToolCall` 授权门、`finishTurn` 迭代上限与超时 |
| 第三层 Application | `src/app/**` | 工具实现、规则/偏好/存储/启动项/语音/角色/CLI，全部经第二层注册，不触碰 pi 内部 API |
