import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../../src/agent/tools/registry.js";
import { nullLogger } from "../../src/runtime/logging/logger.js";
import { Type } from "typebox";
import { SassDeskError } from "../../src/shared/errors.js";
import type { SassDeskTool } from "../../src/agent/tools/types.js";

const EchoParams = Type.Object({ text: Type.String({ minLength: 1 }) });
const echoTool: SassDeskTool<typeof EchoParams> = {
  name: "echo",
  label: "回声",
  description: "回显文本",
  parameters: EchoParams,
  dangerLevel: "safe",
  async execute(_id, params) {
    return { content: [{ type: "text", text: params.text }], details: {} };
  },
};

const SlowParams = Type.Object({});
const slowTool: SassDeskTool<typeof SlowParams> = {
  name: "slow",
  label: "慢工具",
  description: "永不返回",
  parameters: SlowParams,
  dangerLevel: "safe",
  timeoutMs: 30,
  execute: () => new Promise(() => {}),
};

describe("agent/tools/registry", () => {
  it("注册重复工具名直接拒绝（白名单防篡改）", () => {
    const registry = new ToolRegistry(nullLogger());
    registry.register(echoTool);
    expect(() => registry.register({ ...echoTool, execute: echoTool.execute })).toThrowError(/注册冲突/);
  });

  it("wrap 后的 execute 校验参数并拒绝非法输入", async () => {
    const registry = new ToolRegistry(nullLogger());
    const wrapped = registry.wrap(echoTool);
    await expect(wrapped.execute("id1", { text: "" } as never, undefined)).rejects.toThrowError(/参数不合法/);
    await expect(wrapped.execute("id2", { wrong: 1 } as never, undefined)).rejects.toThrowError(SassDeskError);
  });

  it("wrap 后正常参数执行成功", async () => {
    const registry = new ToolRegistry(nullLogger());
    const wrapped = registry.wrap(echoTool);
    const result = await wrapped.execute("id3", { text: "你好" }, undefined);
    expect(result.content[0]).toMatchObject({ type: "text", text: "你好" });
  });

  it("工具超时抛 TOOL_TIMEOUT 并中止执行", async () => {
    const registry = new ToolRegistry(nullLogger());
    const wrapped = registry.wrap(slowTool);
    await expect(wrapped.execute("id4", {}, undefined)).rejects.toMatchObject({ code: "TOOL_TIMEOUT" });
  });

  it("外部取消信号透传为 CANCELLED", async () => {
    const registry = new ToolRegistry(nullLogger());
    const wrapped = registry.wrap(slowTool);
    const controller = new AbortController();
    const p = wrapped.execute("id5", {}, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("validateArgs 提供 JSON Schema 级校验细节", () => {
    const registry = new ToolRegistry(nullLogger());
    const tool = registry.get("echo") ?? echoTool;
    expect(() => registry.validateArgs(tool, { text: "" })).toThrowError(/参数不合法/);
    expect(() => registry.validateArgs(tool, { text: "ok" })).not.toThrow();
  });
});
