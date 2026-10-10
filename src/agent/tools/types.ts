import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * SassDesk 工具扩展类型：在 pi AgentTool 之上加权限级别与超时。
 * 工具实现全部位于第三层（app/**），本文件只定义契约。
 */

/** safe：只读/无副作用，直接执行；confirm：有真实副作用，执行前需用户确认；startup-auth：修改开机自启，需确认 + 规则级授权。 */
export type DangerLevel = "safe" | "confirm" | "startup-auth";

export interface SassDeskTool<TParameters extends import("typebox").TSchema = import("typebox").TSchema> extends AgentTool<TParameters> {
  dangerLevel: DangerLevel;
  /** 工具执行超时（毫秒），默认 15_000。超时通过 AbortSignal 通知工具并抛 TOOL_TIMEOUT。 */
  timeoutMs?: number;
}

export type { AgentTool };
