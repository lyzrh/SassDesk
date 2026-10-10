import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import { SassDeskError } from "../../shared/errors.js";
import type { SassDeskTool } from "./types.js";
import type { Logger } from "../../runtime/logging/logger.js";

/**
 * 工具注册表：
 * - 集中登记所有可用工具（重名即报错，防白名单被无声篡改）；
 * - 统一参数校验（TypeBox Value.Check，双层保险：pi loop 校验 + 本层校验）；
 * - 统一超时与取消包装（AbortSignal.any 组合 agent 信号与超时信号）。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, SassDeskTool<any>>();

  constructor(private readonly logger: Logger) {}

  register(tool: SassDeskTool<any>): void {
    if (this.tools.has(tool.name)) {
      throw new SassDeskError("INTERNAL", `工具注册冲突：${tool.name} 已存在，拒绝覆盖注册（模型不能修改工具白名单）`);
    }
    this.tools.set(tool.name, tool);
    this.logger.info({ tool: tool.name, dangerLevel: tool.dangerLevel }, "工具已注册");
  }

  get(name: string): SassDeskTool<any> | undefined {
    return this.tools.get(name);
  }

  list(): SassDeskTool<any>[] {
    return [...this.tools.values()];
  }

  /** 校验参数（供 beforeToolCall / 测试使用）。 */
  validateArgs(tool: SassDeskTool<any>, args: unknown): void {
    if (!Value.Check(tool.parameters as TSchema, args)) {
      const errors = [...Value.Errors(tool.parameters as TSchema, args)]
        .map((e) => `${(e as { instancePath?: string }).instancePath || "/"}: ${(e as { message?: string }).message ?? "校验失败"}`)
        .join("; ");
      throw new SassDeskError("TOOL_INVALID_ARGS", `工具 ${tool.name} 参数不合法：${errors}`, { args });
    }
  }

  /**
   * 包装后的 execute：校验参数 → 组合取消信号 → 超时控制 → 统一日志。
   * 这是唯一被注册进 pi Agent 的执行入口。
   */
  wrap(tool: SassDeskTool<any>): SassDeskTool<any> {
    const timeoutMs = tool.timeoutMs ?? 15_000;
    const registry = this;
    return {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        registry.validateArgs(tool, params);
        const controller = new AbortController();
        const signals: AbortSignal[] = [controller.signal];
        if (signal) signals.push(signal);
        const composite = AbortSignal.any(signals);

        const timer = setTimeout(() => {
          controller.abort(new SassDeskError("TOOL_TIMEOUT", `工具 ${tool.name} 执行超时（>${timeoutMs}ms）`, { tool: tool.name, timeoutMs }));
        }, timeoutMs);
        const onOuterAbort = () => {
          // agent 级取消（用户 Ctrl+C / run 超时）透传
          if (signal?.reason !== undefined) controller.abort(signal.reason);
          else controller.abort(new SassDeskError("CANCELLED", `工具 ${tool.name} 已被取消`));
        };
        signal?.addEventListener("abort", onOuterAbort, { once: true });

        const start = Date.now();
        // 取消/超时兜底：工具若不响应 signal，也必须让调用方立刻得到失败
        const abortPromise = new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            const reason = composite.reason;
            reject(
              reason instanceof SassDeskError
                ? reason
                : reason instanceof Error
                  ? new SassDeskError("CANCELLED", `工具 ${tool.name} 已被取消：${reason.message}`)
                  : new SassDeskError("CANCELLED", `工具 ${tool.name} 已被取消`),
            );
          };
          if (composite.aborted) onAbort();
          else composite.addEventListener("abort", onAbort, { once: true });
        });
        try {
          const result = await Promise.race([tool.execute(toolCallId, params as never, composite, onUpdate), abortPromise]);
          registry.logger.info(
            { tool: tool.name, toolCallId, durationMs: Date.now() - start, isError: result.isError === true },
            "工具执行完成",
          );
          return result;
        } catch (e) {
          // 超时 → 归一为 TOOL_TIMEOUT；其余按 TOOL_FAILED 上抛（pi 会转为 isError 工具结果）
          if (controller.signal.aborted && controller.signal.reason instanceof SassDeskError && controller.signal.reason.code === "TOOL_TIMEOUT") {
            throw controller.signal.reason;
          }
          if (e instanceof SassDeskError) throw e;
          registry.logger.error({ tool: tool.name, toolCallId, err: String(e) }, "工具执行失败");
          throw new SassDeskError("TOOL_FAILED", `工具 ${tool.name} 执行失败：${(e as Error)?.message ?? String(e)}`, undefined, { cause: e });
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onOuterAbort);
        }
      },
    };
  }
}
