import { describe, it, expect, vi, afterEach } from "vitest";
import { PetStateMachine, type PetStateChange } from "../../src/desktop/state-machine.js";
import { PetController } from "../../src/desktop/pet-controller.js";
import type { AgentRunResult } from "../../src/agent/core/sassdesk-agent.js";

afterEach(() => {
  vi.useRealTimers();
});

function track(machine: PetStateMachine): PetStateChange[] {
  const changes: PetStateChange[] = [];
  machine.subscribe((c) => changes.push(c));
  return changes;
}

describe("desktop/state-machine 正常流转", () => {
  it("idle → listening → thinking → working → success → (hold) → idle", () => {
    vi.useFakeTimers();
    const m = new PetStateMachine();
    const changes = track(m);
    expect(m.state).toBe("idle");

    m.dispatch({ type: "input-start" });
    expect(m.state).toBe("listening");
    m.dispatch({ type: "input-end" });
    expect(m.state).toBe("thinking");
    m.dispatch({ type: "agent-start" });
    expect(m.state).toBe("working");
    m.finishTask(true);
    expect(m.state).toBe("success");

    vi.advanceTimersByTime(3_000); // hold 结束
    expect(m.state).toBe("idle");
    expect(changes.map((c) => c.to)).toEqual(["listening", "thinking", "working", "success", "idle"]);
    m.dispose();
  });

  it("working → task-failed → error（带原因）→ (hold) → idle", () => {
    vi.useFakeTimers();
    const m = new PetStateMachine();
    m.dispatch({ type: "agent-start" });
    expect(m.state).toBe("working");
    m.finishTask(false, "模型调用超时");
    expect(m.state).toBe("error");
    expect(m.errorReason).toBe("模型调用超时");
    vi.advanceTimersByTime(3_000);
    expect(m.state).toBe("idle");
    m.dispose();
  });

  it("idle 超时进入 sleeping，wake 回 idle", () => {
    vi.useFakeTimers();
    const m = new PetStateMachine({ sleepAfterMs: 1_000 });
    vi.advanceTimersByTime(1_100);
    expect(m.state).toBe("sleeping");
    m.dispatch({ type: "wake" });
    expect(m.state).toBe("idle");
    m.dispose();
  });

  it("error 停留期间收到 input-start → 直接进入 listening（不打断 hold 计时残留）", () => {
    vi.useFakeTimers();
    const m = new PetStateMachine();
    m.dispatch({ type: "agent-start" });
    m.finishTask(false);
    expect(m.state).toBe("error");
    m.dispatch({ type: "input-start" });
    expect(m.state).toBe("listening");
    vi.advanceTimersByTime(3_000);
    // hold 计时到期时已不在 success/error，不应误切回 idle
    expect(m.state).toBe("listening");
    m.dispose();
  });
});

describe("desktop/state-machine 优先级与去重", () => {
  it("working 状态下 input-start 不打断工作", () => {
    const m = new PetStateMachine();
    m.dispatch({ type: "agent-start" });
    expect(m.state).toBe("working");
    m.dispatch({ type: "input-start" });
    expect(m.state).toBe("working");
    m.dispose();
  });

  it("相同状态重复 dispatch 不产生状态变化事件", () => {
    const m = new PetStateMachine();
    const changes = track(m);
    m.dispatch({ type: "input-start" });
    m.dispatch({ type: "input-start" });
    m.dispatch({ type: "input-start" });
    expect(changes).toHaveLength(1); // 只有一次 → listening
    m.dispose();
  });

  it("success 状态下 agent-start 可以再次进入 working（新任务）", () => {
    vi.useFakeTimers();
    const m = new PetStateMachine();
    m.dispatch({ type: "agent-start" });
    m.finishTask(true);
    expect(m.state).toBe("success");
    m.dispatch({ type: "agent-start" });
    expect(m.state).toBe("working");
    m.dispose();
  });

  it("thinking 中 task-success 也有效（纯问答无工具调用）", () => {
    const m = new PetStateMachine();
    m.dispatch({ type: "input-start" });
    m.dispatch({ type: "input-end" });
    expect(m.state).toBe("thinking");
    m.finishTask(true);
    expect(m.state).toBe("success");
    m.dispose();
  });
});

describe("desktop/state-machine 资源管理", () => {
  it("dispose 后 dispatch 无效、监听器清空", () => {
    const m = new PetStateMachine();
    const changes = track(m);
    m.dispose();
    m.dispatch({ type: "input-start" });
    expect(m.state).toBe("idle");
    expect(changes).toHaveLength(0);
  });

  it("subscribe 退订后不再收到事件（无监听器泄漏）", () => {
    const m = new PetStateMachine();
    const changes: PetStateChange[] = [];
    const unsub = m.subscribe((c) => changes.push(c));
    m.dispatch({ type: "input-start" });
    unsub();
    m.dispatch({ type: "input-end" });
    expect(changes).toHaveLength(1);
    // 大量订阅/退订不产生泄漏
    for (let i = 0; i < 1000; i++) {
      const u = m.subscribe(() => {});
      u();
    }
    m.dispose();
  });
});

describe("desktop/pet-controller 事件适配", () => {
  function fakeAgent(result: Partial<AgentRunResult>): { run: ReturnType<typeof vi.fn> } {
    return {
      run: vi.fn(async () => ({
        text: "ok",
        truncated: false,
        iterations: 1,
        toolCalls: [],
        ...result,
      }) as AgentRunResult),
    };
  }

  it("runWithAgent 驱动 listening → thinking → working → success 全链路", async () => {
    const c = new PetController({ holdMs: 100 });
    const changes: PetStateChange[] = [];
    c.subscribe((x) => changes.push(x));
    const agent = fakeAgent({ text: "done" }) as never;
    await c.runWithAgent(agent, "你好");
    expect(c.state).toBe("success");
    expect(changes.map((x) => x.to)).toEqual(["listening", "thinking", "working", "success"]);
    c.dispose();
  });

  it("runWithAgent 失败结果 → error（真实结构化判定，非关键词）", async () => {
    const c = new PetController({ holdMs: 50 });
    const agent = fakeAgent({ errorMessage: "API 401" }) as never;
    await c.runWithAgent(agent, "随便说点什么");
    expect(c.state).toBe("error");
    expect(c.machine.errorReason).toBe("API 401");
    c.dispose();
  });

  it("truncated 视为失败（任务未完成）", async () => {
    const c = new PetController({ holdMs: 50 });
    const agent = fakeAgent({ truncated: true }) as never;
    await c.runWithAgent(agent, "复杂任务");
    expect(c.state).toBe("error");
    expect(c.machine.errorReason).toContain("截断");
    c.dispose();
  });

  it("aborted 视为失败", async () => {
    const c = new PetController({ holdMs: 50 });
    const agent = fakeAgent({ aborted: true }) as never;
    await c.runWithAgent(agent, "取消吧");
    expect(c.state).toBe("error");
    c.dispose();
  });
});
