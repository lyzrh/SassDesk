import { createModels, createProvider, envApiKeyAuth, ModelsError } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { stream as openaiCompletionsStream, streamSimple as openaiCompletionsStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { MutableModels, Model } from "@earendil-works/pi-ai";
import type { LlmConfig } from "../config/schema.js";
import { SassDeskError } from "../../shared/errors.js";
import { pickEnvKey } from "../config/load.js";

/**
 * pi-ai 薄适配层：上层（agent/app）只依赖这里的 createSassDeskModels / resolveModel，
 * 不直接 import pi-ai 的 provider 细节。
 */

export type { Model, MutableModels } from "@earendil-works/pi-ai";

/** 内置 provider 列表（与 pi-ai 内置目录一致的最常用子集，用于错误提示）。 */
const KNOWN_PROVIDERS = ["openai", "anthropic", "google", "deepseek", "moonshot", "zai", "openrouter", "groq", "mistral", "xai", "minimax", "azure-openai"] as const;

export interface ModelsBundle {
  models: MutableModels;
}

/**
 * 创建 Models 集合：
 * - 内置 provider 全量注册（openai/anthropic/deepseek/moonshot/zai/...）
 * - provider === "openai-compatible" 时按配置追加一个自定义 provider
 */
export function createSassDeskModels(config: LlmConfig, env: NodeJS.ProcessEnv = process.env): ModelsBundle {
  const models = builtinModels();

  if (config.provider === "openai-compatible") {
    if (!config.baseUrl || config.baseUrl.trim() === "") {
      throw new SassDeskError("CONFIG_INVALID", 'llm.provider 为 "openai-compatible" 时必须配置 llm.baseUrl（例如 https://api.deepseek.com/v1）', { provider: config.provider });
    }
    const apiKey = config.apiKey.trim() !== "" ? config.apiKey : pickEnvKey(env, "openai");
    const customProvider = createProvider({
      id: "openai-compatible",
      name: "OpenAI Compatible",
      baseUrl: config.baseUrl,
      auth: { apiKey: envApiKeyAuth("OpenAI 兼容 API Key", ["SASSDESK_API_KEY", "OPENAI_API_KEY"]) },
      models: [
        {
          id: config.model,
          name: config.model,
          api: "openai-completions",
          provider: "openai-compatible",
          baseUrl: config.baseUrl,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          reasoning: false,
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
      api: {
        "openai-completions": { stream: openaiCompletionsStream, streamSimple: openaiCompletionsStreamSimple },
      },
    });
    models.setProvider(customProvider);
    // 自定义 provider 的 key 已在上方解析，塞进 env 备用（envApiKeyAuth 读环境变量）
    if (apiKey && !env["SASSDESK_API_KEY"]) env["SASSDESK_API_KEY"] = apiKey;
  }

  return { models };
}

/**
 * 解析配置中的 provider/model 为 pi-ai Model 对象。
 * 找不到时抛出含可用清单的中文错误。
 */
export function resolveModel(models: MutableModels, config: LlmConfig): Model<never> | Model<any> {
  const found = models.getModel(config.provider, config.model);
  if (!found) {
    const known: string[] = models.getModels().filter((m) => "reasoning" in m).map((m) => `${m.provider}/${m.id}`);
    const hint = KNOWN_PROVIDERS.join(", ");
    const similar = known.filter((k) => k.startsWith(`${config.provider}/`)).slice(0, 10);
    throw new SassDeskError(
      "CONFIG_INVALID",
      `模型不存在：${config.provider}/${config.model}。` +
        (similar.length > 0 ? `\n该 provider 下的可用模型（部分）：\n  ${similar.join("\n  ")}` : `\n可用 provider 参考：${hint}\n也支持 "openai-compatible" + baseUrl 接入任意 OpenAI 兼容端点。`),
      { provider: config.provider, model: config.model },
    );
  }
  return found;
}

/** 把 pi-ai/ModelsError 转成 SassDeskError（保持错误语义不丢失）。 */
export function normalizeLlmError(e: unknown): SassDeskError {
  if (e instanceof ModelsError) {
    return new SassDeskError("AUTH_MISSING", `模型鉴权失败：${e.message}`, undefined, { cause: e });
  }
  if (e instanceof SassDeskError) return e;
  return new SassDeskError("LLM_ERROR", `模型调用失败：${(e as Error)?.message ?? String(e)}`, undefined, { cause: e });
}
