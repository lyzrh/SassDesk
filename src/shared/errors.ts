/**
 * SassDesk 统一错误体系。
 * 所有可预期失败都应抛出/返回 SassDeskError，携带稳定的机器可读 code 与面向用户的中文 message。
 */

export type SassDeskErrorCode =
  | "CONFIG_MISSING"
  | "CONFIG_INVALID"
  | "AUTH_MISSING"
  | "TOOL_NOT_FOUND"
  | "TOOL_INVALID_ARGS"
  | "TOOL_TIMEOUT"
  | "TOOL_FAILED"
  | "TOOL_BLOCKED"
  | "PROCESS_ERROR"
  | "STARTUP_ERROR"
  | "STORAGE_ERROR"
  | "LLM_ERROR"
  | "VOICE_ERROR"
  | "CANCELLED"
  | "INTERNAL";

export class SassDeskError extends Error {
  readonly code: SassDeskErrorCode;
  readonly details?: unknown;

  constructor(code: SassDeskErrorCode, message: string, details?: unknown, options?: { cause?: unknown }) {
    super(message, options ? { cause: options.cause } : undefined);
    this.name = "SassDeskError";
    this.code = code;
    this.details = details;
  }

  /** 面向用户的一行中文提示（不含堆栈）。 */
  toUserMessage(): string {
    return `[${this.code}] ${this.message}`;
  }
}

export function isSassDeskError(e: unknown): e is SassDeskError {
  return e instanceof SassDeskError;
}

/** 把任意 unknown 错误规整为 Error（保留 message）。 */
export function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  return new Error(typeof e === "string" ? e : JSON.stringify(e));
}
