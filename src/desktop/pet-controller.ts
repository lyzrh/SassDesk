import { PetStateMachine, type PetState, type PetStateChange } from "./state-machine.js";
import type { SassDeskAgent, AgentRunResult } from "../agent/core/sassdesk-agent.js";

/**
 * PetController：真实业务事件 → 角色状态的适配层。
 * - CLI 与桌宠窗口共用；状态来源全部是结构化事实（用户输入、Agent 运行结果），无关键词匹配。
 * - runWithAgent 包裹一次 Agent 运行：提交 → 思考 → 工作 → 成功/失败。
 */
export class PetController {
  readonly machine: PetStateMachine;

  constructor(opts: { holdMs?: number; sleepAfterMs?: number } = {}) {
    this.machine = new PetStateMachine(opts);
  }

  get state(): PetState {
    return this.machine.state;
  }

  /** 监听状态变化（渲染层/CLI 打印用）。 */
  subscribe(listener: (change: PetStateChange) => void): () => void {
    return this.machine.subscribe(listener);
  }

  /** 用户开始输入（语音录音开始 / REPL 行进入前）。 */
  inputStart(): void {
    this.machine.dispatch({ type: "input-start" });
  }

  /** 语音采集结束（文字还没提交给 Agent）。 */
  inputEnd(): void {
    this.machine.dispatch({ type: "input-end" });
  }

  /**
   * 包裹一次 Agent 运行：
   * 提交（thinking）→ agent-start（working）→ 按结构化结果分派 success/error。
   */
  async runWithAgent(agent: SassDeskAgent, text: string, opts: { signal?: AbortSignal } = {}): Promise<AgentRunResult> {
    this.machine.dispatch({ type: "input-end" });
    this.machine.dispatch({ type: "agent-start" });
    const result = await agent.run(text, opts);
    const failed = result.errorMessage !== undefined || result.aborted || result.truncated;
    const reason = result.errorMessage
      ? result.errorMessage
      : result.aborted
        ? "任务已取消"
        : result.truncated
          ? "任务达到最大迭代次数被截断"
          : undefined;
    this.machine.finishTask(!failed, reason);
    return result;
  }

  /** 唤醒/回到待机。 */
  wake(): void {
    this.machine.dispatch({ type: "wake" });
  }

  dispose(): void {
    this.machine.dispose();
  }
}
