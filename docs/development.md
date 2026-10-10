# SassDesk 开发指南

## 环境准备

- Node.js ≥ 22.19（pi-agent-core 的最低要求）
- Windows 10/11（系统工具链依赖 PowerShell 5.1，系统自带）
- IDE：VS Code + TypeScript 插件即可

```powershell
npm install        # 安装依赖
npm run build      # tsc 编译到 dist/
npm start          # 运行 CLI
npm test           # vitest 全量测试
npm run typecheck  # tsc --noEmit
```

## 目录与依赖方向

```
src/runtime/**   第一层（不 import agent/app）
src/agent/**     第二层（只 import runtime）
src/app/**       第三层（可 import agent/runtime）
src/shared/**    通用（任何层可用）
```

改动代码时守住这条规则：**底层出现任何业务 import（音乐/启动项/语音）都是架构破坏**。

## 架构要点

- `agent/core/sassdesk-agent.ts`：对 `pi-agent-core` 的 `Agent` 的唯一封装点。模型解析、`streamFn` 注入、授权门挂载、迭代上限（`finishTurn`）、整轮超时都在这里。
- `agent/tools/registry.ts`：所有工具经 `registry.wrap()` 后才注册进 Agent——统一参数校验（TypeBox `Value.Check`）、超时（`AbortSignal.any` 组合）、错误归一（`SassDeskError`）。
- `agent/core/approval.ts`：授权门 = `beforeToolCall` 钩子。UI 层只提供 `ApprovalHandler` 实现。
- `app/system/**`：所有 Windows 交互（PowerShell、进程、注册表）收敛为接口 + 实现，测试注入 fake。

## 添加一个新工具

1. 在 `src/app/tools/` 新建文件，定义 TypeBox schema 并实现 `SassDeskTool<typeof Params>`；
2. 标注 `dangerLevel`（safe/confirm/startup-auth）与 `timeoutMs`；
3. 在 `bootstrap.ts` 的 `ensureAgent` 中 `registry.register(...)`；
4. 在 `tests/unit/` 或 `tests/integration/` 加测试（fake 依赖，勿触碰真实系统）。

## 测试约定

- **绝不**在测试中真实修改开机启动配置或自动操作 QQ 音乐：一律用 `InMemoryStartupProvider`、fake `ProcessProbe` / `AppLauncher`、临时目录。
- LLM 用 pi 官方 `fauxProvider()`（`@earendil-works/pi-ai` 导出）脚本化响应：
  ```ts
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("hi")]);
  ```
- 集成测试关注：授权同意/拒绝/无 handler 三态、block 后工具不执行、迭代上限触发 truncated、审计 JSONL 落盘。

## 调试

- 日志：`logs/sassdesk-YYYY-MM-DD.log`（pino JSON 行，敏感字段已脱敏）
- 配置问题优先看 CLI 启动时的中文错误（`AUTH_MISSING` / `CONFIG_INVALID` 均带修复指引）
- 真实调用 `models.streamSimple` 前的解析链路：`loadConfig → pickEnvKey → createSassDeskModels → resolveModel`，任一步失败都抛 `SassDeskError`

## 发布流程

```powershell
npm run typecheck && npm test && npm run build
git add -A && git commit -m "release: ..."
git tag v0.1.0
git push origin main --tags
```
