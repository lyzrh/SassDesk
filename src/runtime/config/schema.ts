import { Type, type Static } from "typebox";

/**
 * SassDesk 配置 schema（TypeBox）。
 * 加载顺序：内置默认 → config.json → config.local.json → 环境变量。
 */

export const LlmConfigSchema = Type.Object({
  /** 是否接入 API（false 时 CLI 走纯命令模式，不要求 API Key、不调用模型） */
  enabled: Type.Boolean({ default: true, description: "是否接入模型 API" }),
  /** provider id：内置（openai/anthropic/deepseek/moonshot/zai/google/openrouter...）或 "openai-compatible" */
  provider: Type.String({ default: "openai", description: "模型提供商" }),
  model: Type.String({ default: "gpt-4o-mini", description: "模型 ID" }),
  /** 仅 openai-compatible 需要 */
  baseUrl: Type.String({ default: "", description: "OpenAI 兼容端点地址" }),
  /** 留空则从环境变量读取（SASSDESK_API_KEY 或 <PROVIDER>_API_KEY） */
  apiKey: Type.String({ default: "", description: "API Key（建议留空走环境变量）" }),
  /** 单次任务最大工具轮数（Agent Loop 迭代上限） */
  maxIterations: Type.Number({ default: 8, minimum: 1, maximum: 40 }),
  /** 单次 LLM 请求超时（毫秒） */
  requestTimeoutMs: Type.Number({ default: 120_000, minimum: 5_000 }),
});

export const VoiceConfigSchema = Type.Object({
  /** mock | sapi | whisper */
  provider: Type.String({ default: "mock" }),
  sttBaseUrl: Type.String({ default: "" }),
  sttModel: Type.String({ default: "whisper-1" }),
  recordTimeoutMs: Type.Number({ default: 120_000, minimum: 5_000 }),
});

export const MusicConfigSchema = Type.Object({
  qqmusicPath: Type.String({ default: "" }),
});

export const CharacterConfigSchema = Type.Object({
  name: Type.String({ default: "Sass" }),
});

export const LoggingConfigSchema = Type.Object({
  level: Type.Union(
    [Type.Literal("fatal"), Type.Literal("error"), Type.Literal("warn"), Type.Literal("info"), Type.Literal("debug"), Type.Literal("trace")],
    { default: "info" },
  ),
  dir: Type.String({ default: "logs" }),
});

export const AppConfigSchema = Type.Object({
  llm: LlmConfigSchema,
  voice: VoiceConfigSchema,
  music: MusicConfigSchema,
  character: CharacterConfigSchema,
  logging: LoggingConfigSchema,
});

export type AppConfig = Static<typeof AppConfigSchema>;
export type LlmConfig = Static<typeof LlmConfigSchema>;
export type VoiceConfig = Static<typeof VoiceConfigSchema>;
export type LoggingConfig = Static<typeof LoggingConfigSchema>;
