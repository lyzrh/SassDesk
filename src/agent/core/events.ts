import type { AgentEvent } from "@earendil-works/pi-agent-core";

/**
 * 事件桥：把 pi Agent 事件转换为上层（CLI）可读的展示回调。
 * 保持第二层与展示解耦：这里不做任何 I/O，只做事件分类。
 */

export interface EventBridgeHooks {
  /** assistant 文本增量（流式）。 */
  onTextDelta?(delta: string): void;
  /** 一次工具调用开始。 */
  onToolStart?(info: { toolName: string; argsSummary: string }): void;
  /** 一次工具调用结束。 */
  onToolEnd?(info: { toolName: string; durationMs?: number; isError: boolean; resultSummary: string }): void;
  /** 一轮（LLM 调用+工具执行）结束。 */
  onTurnEnd?(info: { index: number }): void;
  /** 运行结束。 */
  onRunEnd?(): void;
  /** 运行错误。 */
  onError?(message: string): void;
}

export function summarizeForDisplay(value: unknown, maxLen = 160): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

/** 创建事件监听器（直接可传给 agent.subscribe）。 */
export function createEventBridge(hooks: EventBridgeHooks): (event: AgentEvent) => void {
  let turnIndex = 0;
  return (event: AgentEvent) => {
    switch (event.type) {
      case "message_update": {
        const ev = (event as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
        if (ev?.type === "text_delta" && ev.delta) hooks.onTextDelta?.(ev.delta);
        break;
      }
      case "tool_execution_start":
        hooks.onToolStart?.({ toolName: event.toolName, argsSummary: summarizeForDisplay(event.args) });
        break;
      case "tool_execution_end": {
        const resultText = summarizeForDisplay((event.result as { content?: unknown[] })?.content ?? event.result);
        hooks.onToolEnd?.({ toolName: event.toolName, durationMs: event.durationMs, isError: event.isError, resultSummary: resultText });
        break;
      }
      case "turn_end":
        turnIndex += 1;
        hooks.onTurnEnd?.({ index: turnIndex });
        break;
      case "agent_end":
        hooks.onRunEnd?.();
        break;
      default:
        break;
    }
    // 错误经 assistant 消息 stopReason 报告（在 sassdesk-agent.run 中汇总），此处不重复处理
  };
}
