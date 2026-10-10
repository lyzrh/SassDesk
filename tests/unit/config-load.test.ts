import { describe, it, expect } from "vitest";
import { loadConfig, defaultConfig, requireApiKey, pickEnvKey } from "../../src/runtime/config/load.js";
import { SassDeskError } from "../../src/shared/errors.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sassdesk-config-"));
}

describe("config/load", () => {
  it("无配置文件时返回全部默认值", () => {
    const dir = makeTempDir();
    const { config } = loadConfig({ configDir: dir, env: {} });
    expect(config).toEqual(defaultConfig());
  });

  it("config.json 与 config.local.json 依次覆盖默认值", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ llm: { model: "custom-model" } }));
    fs.writeFileSync(path.join(dir, "config.local.json"), JSON.stringify({ character: { name: "小鱼" } }));
    const { config } = loadConfig({ configDir: dir, env: {} });
    expect(config.llm.model).toBe("custom-model");
    expect(config.llm.provider).toBe("openai"); // 未覆盖字段保留默认
    expect(config.character.name).toBe("小鱼");
  });

  it("环境变量 API Key 覆盖配置文件", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "config.local.json"), JSON.stringify({ llm: { apiKey: "config-key" } }));
    const { config } = loadConfig({ configDir: dir, env: { SASSDESK_API_KEY: "env-key" } });
    expect(config.llm.apiKey).toBe("env-key");
  });

  it("pickEnvKey 按 SASSDESK > SASSDESK_<PROVIDER> > <PROVIDER> 顺序解析", () => {
    expect(pickEnvKey({ DEEPSEEK_API_KEY: "d1" } as NodeJS.ProcessEnv, "deepseek")).toBe("d1");
    expect(pickEnvKey({ SASSDESK_API_KEY: "s", DEEPSEEK_API_KEY: "d" } as NodeJS.ProcessEnv, "deepseek")).toBe("s");
    expect(pickEnvKey({} as NodeJS.ProcessEnv, "deepseek")).toBe("");
  });

  it("配置文件损坏时非严格模式警告并跳过", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "config.json"), "{broken json");
    const { config, warnings } = loadConfig({ configDir: dir, env: {} });
    expect(config.llm.provider).toBe("openai");
    // 非严格模式走 console.warn，warnings 数组由读文件逻辑填充为空（直接跳过）
    expect(warnings).toEqual([]);
  });

  it("配置文件损坏且 SASSDESK_STRICT_CONFIG=1 时抛 CONFIG_INVALID", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "config.json"), "{broken json");
    expect(() => loadConfig({ configDir: dir, env: { SASSDESK_STRICT_CONFIG: "1" } as NodeJS.ProcessEnv })).toThrowError(SassDeskError);
  });

  it("非法配置值被 schema 校验拒绝", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ llm: { maxIterations: 0 } }));
    expect(() => loadConfig({ configDir: dir, env: {} })).toThrowError(/maxIterations|minimum|校验失败/);
  });

  it("requireApiKey 缺失时抛出含配置指引的中文错误", () => {
    const cfg = { ...defaultConfig().llm, apiKey: "" };
    try {
      requireApiKey(cfg, {} as NodeJS.ProcessEnv);
      expect.unreachable("应该抛出 AUTH_MISSING");
    } catch (e) {
      expect(e).toBeInstanceOf(SassDeskError);
      expect((e as SassDeskError).code).toBe("AUTH_MISSING");
      expect((e as Error).message).toContain("config.local.json");
      expect((e as Error).message).toContain("SASSDESK_API_KEY");
    }
  });
});
