import type { AgentOptions, BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { ToolRegistry } from "../tools/registry.js";
import { isSassDeskError } from "../../shared/errors.js";
import type { Logger } from "../../runtime/logging/logger.js";

/**
 * 授权门（Approval Gate）：
 * 挂在 Agent.beforeToolCall 上，宿主程序侧强制执行——模型无法绕过。
 * - safe：直接放行
 * - confirm：经 ApprovalHandler 征求用户同意
 * - startup-auth：同 confirm（提示涉及开机启动授权）
 * 无交互环境（非 TTY）时默认拒绝非 safe 工具，避免后台自动执行副作用。
 */

export interface ApprovalRequest {
  toolName: string;
  toolLabel: string;
  args: unknown;
  /** 传给用户的确认说明（含参数摘要与影响）。 */
  summary: string;
}

export interface ApprovalHandler {
  /** resolve(true) = 用户同意；resolve(false) = 用户拒绝。 */
  requestApproval(req: ApprovalRequest): Promise<boolean>;
}

/** 生成参数摘要（JSON 截断，防日志爆炸）。 */
export function summarizeArgs(args: unknown, maxLen = 300): string {
  let text: string;
  try {
    text = JSON.stringify(args);
  } catch {
    text = String(args);
  }
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

export function createApprovalGate(opts: { registry: ToolRegistry; handler?: ApprovalHandler; logger: Logger }): NonNullable<AgentOptions["beforeToolCall"]> {
  return async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    const tool = opts.registry.get(ctx.toolCall.name);
    if (!tool) {
      // 未注册工具理论上到不了这里（pi 只会调用已声明工具），防御性拒绝
      return { block: true, reason: `工具 ${ctx.toolCall.name} 不在白名单中，已拒绝执行。` };
    }
    // registry.validateArgs 再校验一遍（pi 已校验过，双保险）
    try {
      opts.registry.validateArgs(tool, ctx.args);
    } catch (e) {
      const msg = isSassDeskError(e) ? e.message : `工具 ${tool.name} 参数校验失败`;
      return { block: true, reason: msg };
    }
    if (tool.dangerLevel === "safe") return undefined;

    const handler = opts.handler;
    if (!handler) {
      const reason = `当前为非交互环境，工具 ${tool.name}（${tool.label}）需要用户确认但无法询问，已拒绝。请在交互式 CLI 中重试。`;
      opts.logger.warn({ tool: tool.name }, "非交互环境拒绝需要确认的工具");
      return { block: true, reason };
    }

    const summary =
      `即将执行【${tool.label}】（${tool.name}）` +
      (tool.dangerLevel === "startup-auth" ? "，该操作会修改开机启动配置。" : "。") +
      `\n参数：${summarizeArgs(ctx.args)}`;
    let approved: boolean;
    try {
      approved = await handler.requestApproval({ toolName: tool.name, toolLabel: tool.label, args: ctx.args, summary });
    } catch (e) {
      return { block: true, reason: `确认过程出错，已拒绝执行：${(e as Error)?.message ?? String(e)}` };
    }
    if (!approved) {
      opts.logger.info({ tool: tool.name }, "用户拒绝工具执行");
      return { block: true, reason: `用户拒绝了【${tool.label}】的执行。请向用户说明操作未执行，并询问是否需要调整方案。` };
    }
    return undefined;
  };
}
