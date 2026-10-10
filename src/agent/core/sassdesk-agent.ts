import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentOptions, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, MutableModels } from "@earendil-works/pi-ai";
import type { LlmConfig } from "../../runtime/config/schema.js";
import type { Logger } from "../../runtime/logging/logger.js";
import { SassDeskError } from "../../shared/errors.js";
import { resolveModel } from "../../runtime/llm/models.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ApprovalHandler } from "./approval.js";
import { createApprovalGate } from "./approval.js";

/**
 * SassDeskAgent：对 pi-agent-core Agent 的封装。
 * 职责：
 * - 注入 systemPrompt / 模型 / 工具（经注册表 wrap：校验+超时）
 * - 授权门（beforeToolCall）
 * - 迭代上限（finishTurn）与整轮超时（AbortController）
 * - 汇总运行结果（文本、用量、工具调用记录）
 * 不包含任何产品业务（音乐/启动项/语音）。
 */

export interface AgentToolCallRecord {
  name: string;
  toolCallId: string;
  durationMs?: number;
  isError: boolean;
}

export interface AgentRunResult {
  /** 最终 assistant 回复文本（可能为空：如全程工具执行后被截断）。 */
  text: string;
  truncated: boolean;
  iterations: number;
  toolCalls: AgentToolCallRecord[];
  usage?: { input: number; output: number; costTotal: number };
  errorMessage?: string;
  aborted: boolean;
}

export interface SassDeskAgentOptions {
  systemPrompt: string;
  config: LlmConfig;
  models: MutableModels;
  registry: ToolRegistry;
  approvalHandler?: ApprovalHandler;
  logger: Logger;
}

export class SassDeskAgent {
  readonly agent: Agent;
  private readonly config: LlmConfig;
  private readonly logger: Logger;

  constructor(options: SassDeskAgentOptions) {
    this.config = options.config;
    this.logger = options.logger.child({ component: "agent" });

    const model = resolveModel(options.models, options.config);
    const wrappedTools: AgentTool<any>[] = options.registry.list().map((t) => options.registry.wrap(t));

    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model: model as never,
        thinkingLevel: "off",
        tools: wrappedTools,
        messages: [],
      },
      streamFn: options.models.streamSimple.bind(options.models) as AgentOptions["streamFn"],
      beforeToolCall: createApprovalGate({ registry: options.registry, handler: options.approvalHandler, logger: options.logger }),
      toolExecution: "sequential",
    });
  }

  /** 发送一条用户消息并等待运行结束。 */
  async run(userText: string, opts: { signal?: AbortSignal } = {}): Promise<AgentRunResult> {
    let iterations = 0;
    let truncated = false;
    const toolCalls: AgentToolCallRecord[] = [];
    let lastAssistantText = "";
    let allAssistantTexts: string[] = [];
    let lastUsage: AgentRunResult["usage"];
    let errorMessage: string | undefined;
    let aborted = false;

    const unsubscribe = this.agent.subscribe((event: AgentEvent) => {
      if (event.type === "message_end" && isAssistantMessage(event.message)) {
        const text = event.message.content
          .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (text.trim() !== "") {
          allAssistantTexts.push(text);
          lastAssistantText = text;
        }
        const u = event.message.usage;
        if (u) lastUsage = { input: u.input, output: u.output, costTotal: u.cost?.total ?? 0 };
        if (event.message.stopReason === "aborted") aborted = true;
        if (event.message.stopReason === "error") errorMessage = event.message.errorMessage ?? "模型返回错误";
      } else if (event.type === "tool_execution_end") {
        toolCalls.push({ name: event.toolName, toolCallId: event.toolCallId, durationMs: event.durationMs, isError: event.isError });
      }
    });

    // 迭代上限：挂在 Agent 构造之外用 setter 不可行（Agent 构造时没暴露 finishTurn 闭包状态），
    // 这里改用 subscribe 前置：为每次 run 动态设置 finishTurn（Agent 实例属性可写）。
    const maxIterations = this.config.maxIterations;
    this.agent.finishTurn = () => {
      iterations += 1;
      if (iterations >= maxIterations) {
        truncated = true;
        return { action: "end" as const };
      }
      return undefined;
    };

    // 整轮超时：单请求超时 × 迭代上限（粗略上限，防无限卡死）
    const runTimeoutMs = this.config.requestTimeoutMs * maxIterations;
    const timeout = setTimeout(() => {
      this.logger.warn({ runTimeoutMs }, "任务总耗时超限，触发取消");
      this.agent.abort();
    }, runTimeoutMs);

    const onOuterSignal = () => this.agent.abort();
    opts.signal?.addEventListener("abort", onOuterSignal, { once: true });

    try {
      await this.agent.prompt(userText);
      await this.agent.waitForIdle();
    } catch (e) {
      errorMessage = errorMessage ?? (e instanceof SassDeskError ? e.toUserMessage() : (e as Error)?.message ?? String(e));
    } finally {
      clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", onOuterSignal);
      unsubscribe();
    }

    if (truncated) {
      this.logger.warn({ iterations, maxIterations }, "任务达到最大迭代次数被截断");
    }

    return {
      text: lastAssistantText || allAssistantTexts.join("\n"),
      truncated,
      iterations,
      toolCalls,
      usage: lastUsage,
      errorMessage,
      aborted,
    };
  }

  /** 取消当前运行。 */
  abort(): void {
    this.agent.abort();
  }

  /** 订阅事件流（CLI 打印用）。 */
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
    return this.agent.subscribe(listener);
  }

  /** 追加一条系统级提示（如角色切换、偏好更新），对模型可见。 */
  async injectSystemNote(note: string): Promise<void> {
    this.agent.state.messages = [
      ...this.agent.state.messages,
      { role: "system", content: note, timestamp: Date.now() },
    ];
  }

  get isBusy(): boolean {
    return this.agent.state.isStreaming;
  }
}

function isAssistantMessage(m: unknown): m is AssistantMessage {
  return typeof m === "object" && m !== null && (m as { role?: string }).role === "assistant";
}
