import type { LlmConfig } from "../config/schema.js";
import { requireApiKey } from "../config/load.js";
import { createSassDeskModels, resolveModel, normalizeLlmError } from "./models.js";

/**
 * 一次性中文问答（无工具、无 Agent Loop）——用于验收「配置真实模型后完成一次问答」。
 * 复用与 Agent 相同的模型解析链路，保证配置一致性。
 */
export async function simpleChat(config: LlmConfig, userText: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  try {
    const apiKey = requireApiKey(config, env);
    const { models } = createSassDeskModels(config, env);
    const model = resolveModel(models, config);
    const message = await models.completeSimple(
      model,
      {
        systemPrompt: "你是 SassDesk，一个运行在用户 Windows 电脑上的中文 AI 员工。请用简体中文、简洁自然地回答。",
        messages: [{ role: "user", content: userText, timestamp: Date.now() }],
      },
      { apiKey },
    );
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw normalizeLlmError(new Error(message.errorMessage ?? `stopReason=${message.stopReason}`));
    }
    const parts: string[] = [];
    for (const block of message.content) {
      if (block.type === "text") parts.push(block.text);
    }
    return parts.join("\n").trim();
  } catch (e) {
    throw normalizeLlmError(e);
  }
}
