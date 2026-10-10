import { describe, it, expect, beforeEach } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai";
import { ToolRegistry } from "../../src/agent/tools/registry.js";
import { SassDeskAgent } from "../../src/agent/core/sassdesk-agent.js";
import { nullLogger } from "../../src/runtime/logging/logger.js";
import { defaultConfig } from "../../src/runtime/config/load.js";
import { Type } from "typebox";
import type { SassDeskTool } from "../../src/agent/tools/types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * 集成测试：faux LLM（官方测试 provider）驱动真实 Agent Loop + 工具注册表 + 授权门。
 * 不触碰真实模型、真实进程、真实注册表。
 */

let tmpDir: string;
let fakeExe: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sassdesk-int-"));
  fakeExe = path.join(tmpDir, "QQMusic.exe");
  fs.writeFileSync(fakeExe, "fake");
});

/** 构造带 fake 依赖的 qqmusic_start 工具（进程探测可脚本化；记录 execute 是否真实运行）。 */
function makeQQMusicStartTool(opts: { probeSequence: number[][], executedRef?: { called: boolean } }): SassDeskTool<any> {
  const Params = Type.Object({});
  let probeCall = 0;
  const tool: SassDeskTool<typeof Params> = {
    name: "qqmusic_start",
    label: "启动 QQ 音乐",
    description: "启动 QQ 音乐客户端（测试桩）",
    parameters: Params,
    dangerLevel: "confirm",
    timeoutMs: 5_000,
    async execute() {
      if (opts.executedRef) opts.executedRef.called = true;
      // 模拟 QQMusicLauncher.start 行为：轮询 probeSequence
      const pids = opts.probeSequence[Math.min(probeCall, opts.probeSequence.length - 1)] ?? [];
      probeCall += 1;
      const running = pids.length > 0;
      return {
        content: [
          {
            type: "text",
            text: running ? `QQ 音乐客户端已启动（pid: ${pids.join(", ")}）。` : "启动命令已发送，但未检测到进程。",
          },
        ],
        details: { phase: running ? "launched" : "failed", processConfirmed: running, clientRunning: running, pids },
      };
    },
  };
  return tool;
}

function makeAgent(opts: { tools: SassDeskTool<any>[]; responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>; approvalHandler?: { requestApproval(req: unknown): Promise<boolean> } }): { agent: SassDeskAgent; faux: ReturnType<typeof fauxProvider> } {
  const faux = fauxProvider();
  const models = createModels() as MutableModels;
  models.setProvider(faux.provider);
  faux.setResponses(opts.responses);

  const registry = new ToolRegistry(nullLogger());
  for (const t of opts.tools) registry.register(t);

  const config = {
    ...defaultConfig().llm,
    provider: faux.provider.id,
    model: faux.models[0]!.id,
  };

  const agent = new SassDeskAgent({
    systemPrompt: "测试提示词",
    config,
    models,
    registry,
    approvalHandler: opts.approvalHandler
      ? { requestApproval: opts.approvalHandler.requestApproval as never }
      : undefined,
    logger: nullLogger(),
  });
  return { agent, faux };
}

describe("integration: Agent Loop + 工具 + 授权门", () => {
  it("纯文本问答：模型回复直接返回", async () => {
    const { agent } = makeAgent({
      tools: [],
      responses: [fauxAssistantMessage("你好，我是大肥鱼。")],
    });
    const result = await agent.run("你好");
    expect(result.text).toBe("你好，我是大肥鱼。");
    expect(result.truncated).toBe(false);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.errorMessage).toBeUndefined();
  });

  it("工具调用链：模型发起 qqmusic_start → 授权同意 → 工具执行 → 模型总结", async () => {
    const approvals: string[] = [];
    const { agent } = makeAgent({
      tools: [
        makeQQMusicStartTool({
          probeSequence: [[], [12345]],
        }),
      ],
      responses: [
        fauxAssistantMessage([fauxToolCall("qqmusic_start", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage("QQ 音乐已启动（进程 12345 已确认）。"),
      ],
      approvalHandler: {
        requestApproval: async (req) => {
          approvals.push((req as { toolName: string }).toolName);
          return true;
        },
      },
    });
    const result = await agent.run("打开 QQ 音乐");
    expect(approvals).toEqual(["qqmusic_start"]);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ name: "qqmusic_start", isError: false });
    expect(result.text).toContain("已启动");
    expect(result.iterations).toBeGreaterThanOrEqual(1);
  });

  it("用户拒绝授权：工具被 block，未真实执行，模型收到拒绝原因", async () => {
    const executedRef = { called: false };
    const { agent } = makeAgent({
      tools: [makeQQMusicStartTool({ probeSequence: [[], [1]], executedRef })],
      responses: [
        fauxAssistantMessage([fauxToolCall("qqmusic_start", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage("好的，已取消，不会执行。"),
      ],
      approvalHandler: { requestApproval: async () => false },
    });
    const result = await agent.run("打开 QQ 音乐");
    expect(executedRef.called).toBe(false); // 工具从未真实执行
    expect(result.toolCalls[0]).toMatchObject({ name: "qqmusic_start", isError: true }); // 以错误工具结果回传模型
    expect(result.text).toContain("取消");
  });

  it("非交互环境（无 handler）：confirm 工具被拒绝且不执行", async () => {
    const executedRef = { called: false };
    const { agent } = makeAgent({
      tools: [makeQQMusicStartTool({ probeSequence: [[], [1]], executedRef })],
      responses: [
        fauxAssistantMessage([fauxToolCall("qqmusic_start", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage("当前无法执行需要确认的操作。"),
      ],
    });
    const result = await agent.run("打开 QQ 音乐");
    expect(executedRef.called).toBe(false);
    expect(result.toolCalls[0]).toMatchObject({ isError: true });
  });

  it("迭代上限：达到 maxIterations 后强制结束并标记 truncated", async () => {
    // 模型无限要求工具调用
    const loopResponses = Array.from({ length: 4 }, () => fauxAssistantMessage([fauxToolCall("qqmusic_start", {})], { stopReason: "toolUse" }));
    const { agent } = makeAgent({
      tools: [makeQQMusicStartTool({ probeSequence: [[9]] })],
      responses: loopResponses,
      approvalHandler: { requestApproval: async () => true },
    });
    // 手动把 maxIterations 降到 2（通过 config）
    (agent as unknown as { config: { maxIterations: number } }).config.maxIterations = 2;
    const result = await agent.run("循环测试");
    expect(result.truncated).toBe(true);
    expect(result.iterations).toBe(2);
  });

  it("模型停止后 usage 汇总可用", async () => {
    const { agent } = makeAgent({
      tools: [],
      responses: [fauxAssistantMessage("收到")],
    });
    const result = await agent.run("测试");
    expect(result.usage).toBeDefined();
    expect(result.usage?.input).toBeGreaterThanOrEqual(0);
  });
});
