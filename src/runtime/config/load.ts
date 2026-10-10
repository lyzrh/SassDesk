import fs from "node:fs";
import path from "node:path";
import { Value } from "typebox/value";
import { AppConfigSchema, type AppConfig, type LlmConfig } from "./schema.js";
import { loadDotEnv } from "./dotenv.js";
import { SassDeskError } from "../../shared/errors.js";
import { resolveConfigDir } from "../../shared/paths.js";

export interface LoadConfigOptions {
  /** 项目根/配置目录（默认 resolveConfigDir()） */
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** 代码内默认配置（与 schema 默认值保持一致；合并顺序的基底）。 */
export function defaultConfig(): AppConfig {
  return {
    llm: {
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "",
      apiKey: "",
      maxIterations: 8,
      requestTimeoutMs: 120_000,
    },
    voice: {
      provider: "mock",
      sttBaseUrl: "",
      sttModel: "whisper-1",
      recordTimeoutMs: 120_000,
    },
    music: {
      qqmusicPath: "",
    },
    character: {
      name: "大肥鱼",
    },
    logging: {
      level: "info",
      dir: "logs",
    },
  };
}

function readJsonIfExists(file: string, env: NodeJS.ProcessEnv): Record<string, unknown> {
  try {
    const text = fs.readFileSync(file, "utf-8");
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new SassDeskError("CONFIG_INVALID", `配置文件 ${file} 不是合法的 JSON 对象`, { file });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    // 配置文件损坏：给出清楚中文提示，不静默失败
    const msg = `配置文件损坏或不可读：${file}（${(err as Error).message}）。请修复或删除该文件后重试。`;
    if (env["SASSDESK_STRICT_CONFIG"] === "1") throw new SassDeskError("CONFIG_INVALID", msg, { file });
    // 非严格模式：跳过坏文件但明确警告（由调用方打印）
    console.warn(`[SassDesk] 警告：${msg}（已跳过该文件，继续以默认配置启动；可设 SASSDESK_STRICT_CONFIG=1 使其报错退出）`);
    return {};
  }
}

/**
 * 加载并校验配置：
 * env > config.local.json > config.json > schema 默认值。
 */
export function loadConfig(options: LoadConfigOptions = {}): { config: AppConfig; configDir: string; warnings: string[] } {
  const env = options.env ?? process.env;
  const configDir = options.configDir ?? resolveConfigDir(env);
  const warnings: string[] = [];

  loadDotEnv(configDir, options.cwd ? path.resolve(options.cwd) : process.cwd());

  const base = readJsonIfExists(path.join(configDir, "config.json"), env);
  const local = readJsonIfExists(path.join(configDir, "config.local.json"), env);
  // 合并顺序：代码默认值 → config.json → config.local.json（env 随后覆盖）
  const merged = deepMerge(deepMerge(defaultConfig() as unknown as Record<string, unknown>, base), local);

  if (!Value.Check(AppConfigSchema, merged)) {
    const errors = [...Value.Errors(AppConfigSchema, merged)]
      .map((e) => `${(e as { instancePath?: string }).instancePath || "/"}: ${(e as { message?: string }).message ?? "校验失败"}`)
      .join("; ");
    throw new SassDeskError("CONFIG_INVALID", `配置校验失败：${errors}`, { merged });
  }
  const config = structuredClone(merged) as unknown as AppConfig;

  // 环境变量覆盖 LLM API Key（最高优先级）
  const envKey = pickEnvKey(env, config.llm.provider);
  if (envKey) config.llm.apiKey = envKey;

  return { config, configDir, warnings };
}

/** 解析指定 provider 的 API Key：SASSDESK_API_KEY > SASSDESK_<PROVIDER>_API_KEY > <PROVIDER>_API_KEY。 */
export function pickEnvKey(env: NodeJS.ProcessEnv, provider: string): string {
  const upper = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const candidates = [
    env["SASSDESK_API_KEY"],
    env[`SASSDESK_${upper}_API_KEY`],
    env[`${upper}_API_KEY`],
  ];
  for (const c of candidates) {
    if (c && c.trim() !== "") return c.trim();
  }
  return "";
}

export function requireApiKey(config: LlmConfig, env: NodeJS.ProcessEnv = process.env): string {
  const key = config.apiKey.trim() !== "" ? config.apiKey : pickEnvKey(env, config.provider);
  if (!key) {
    throw new SassDeskError(
      "AUTH_MISSING",
      `未找到模型 API Key。请选择任一方式配置后重试：\n` +
        `  1. 在项目根目录创建 config.local.json：{"llm":{"apiKey":"sk-..."}}\n` +
        `  2. 复制 .env.example 为 .env 并填写 SASSDESK_API_KEY=<你的Key>\n` +
        `  3. 设置系统环境变量（当前 provider: ${config.provider}）`,
      { provider: config.provider },
    );
  }
  return key;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(source)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const existing = target[k];
      target[k] = deepMerge(
        existing !== null && typeof existing === "object" && !Array.isArray(existing) ? (existing as Record<string, unknown>) : {},
        v as Record<string, unknown>,
      );
    } else if (v !== undefined) {
      target[k] = v;
    }
  }
  return target;
}
