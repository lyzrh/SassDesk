import { describe, it, expect } from "vitest";
import { createApprovalGate, summarizeArgs, type ApprovalHandler } from "../../src/agent/core/approval.js";
import { ToolRegistry } from "../../src/agent/tools/registry.js";
import { nullLogger } from "../../src/runtime/logging/logger.js";
import { Type } from "typebox";
import type { SassDeskTool } from "../../src/agent/tools/types.js";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";

const Params = Type.Object({ path: Type.String() });
const safeTool: SassDeskTool<typeof Params> = {
  name: "read_thing",
  label: "读点东西",
  description: "safe 只读",
  parameters: Params,
  dangerLevel: "safe",
  async execute(_id, params) {
    return { content: [{ type: "text", text: params.path }], details: {} };
  },
};

const dangerTool: SassDeskTool<typeof Params> = {
  ...safeTool,
  name: "write_thing",
  label: "写点东西",
  description: "confirm 有副作用",
  dangerLevel: "confirm",
};

const startupTool: SassDeskTool<typeof Params> = {
  ...safeTool,
  name: "enable_startup",
  label: "改开机启动",
  description: "startup-auth",
  dangerLevel: "startup-auth",
};

function makeCtx(toolName: string, args: unknown): BeforeToolCallContext {
  return {
    assistantMessage: { role: "assistant", content: [], stopReason: "toolUse", usage: { input: 0, output: 0, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, api: "openai-completions", provider: "faux", model: "m", id: "m", timestamp: Date.now() },
    toolCall: { type: "toolCall", id: "call-1", name: toolName, arguments: args },
    args,
    context: { messages: [], tools: [] },
  } as unknown as BeforeToolCallContext;
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry(nullLogger());
  registry.register(safeTool);
  registry.register(dangerTool);
  registry.register(startupTool);
  return registry;
}

describe("agent/core/approval 授权门", () => {
  it("safe 工具直接放行", async () => {
    const gate = createApprovalGate({ registry: makeRegistry(), logger: nullLogger() });
    expect(await gate(makeCtx("read_thing", { path: "x" }))).toBeUndefined();
  });

  it("confirm 工具无 handler 时拒绝（非交互环境）", async () => {
    const gate = createApprovalGate({ registry: makeRegistry(), logger: nullLogger() });
    const result = await gate(makeCtx("write_thing", { path: "x" }));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("非交互环境");
  });

  it("confirm 工具用户拒绝时 block 并带原因", async () => {
    const handler: ApprovalHandler = { requestApproval: async () => false };
    const gate = createApprovalGate({ registry: makeRegistry(), handler, logger: nullLogger() });
    const result = await gate(makeCtx("write_thing", { path: "x" }));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("用户拒绝");
  });

  it("confirm 工具用户同意时放行", async () => {
    const handler: ApprovalHandler = { requestApproval: async () => true };
    const gate = createApprovalGate({ registry: makeRegistry(), handler, logger: nullLogger() });
    expect(await gate(makeCtx("write_thing", { path: "x" }))).toBeUndefined();
  });

  it("startup-auth 工具同样需要确认", async () => {
    const handler: ApprovalHandler = { requestApproval: async () => false };
    const gate = createApprovalGate({ registry: makeRegistry(), handler, logger: nullLogger() });
    const result = await gate(makeCtx("enable_startup", { path: "x" }));
    expect(result?.block).toBe(true);
  });

  it("参数不合法时拒绝执行（参数摘要含在 reason）", async () => {
    const handler: ApprovalHandler = { requestApproval: async () => true };
    const gate = createApprovalGate({ registry: makeRegistry(), handler, logger: nullLogger() });
    const result = await gate(makeCtx("write_thing", { path: 123 }));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("参数");
  });

  it("summarizeArgs 截断长参数", () => {
    const long = JSON.stringify({ a: "x".repeat(500) });
    expect(summarizeArgs({ a: "x".repeat(500) }).length).toBeLessThan(long.length);
  });
});
