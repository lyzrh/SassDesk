/**
 * Sass 角色状态机（纯逻辑，无 I/O，可独立单测）。
 *
 * 设计约束：
 * - 状态由真实业务事件驱动（用户输入、Agent 生命周期、结构化的任务结果），
 *   绝不通过搜索 LLM 文本中的"成功/失败"关键词判断。
 * - 带优先级与去重：高优先级事件不会被低优先级事件反复覆盖；相同状态重复触发不产生副作用。
 * - 定时器集中管理，dispose() 保证不泄漏。
 */

export type PetState = "idle" | "listening" | "thinking" | "working" | "success" | "error" | "sleeping";

export type PetEvent =
  | { type: "input-start" }
  | { type: "input-end" }
  | { type: "agent-start" }
  | { type: "task-success" }
  | { type: "task-failed"; reason?: string }
  | { type: "idle-timeout" }
  | { type: "wake" }
  | { type: "reset" };

export interface PetStateChange {
  from: PetState;
  to: PetState;
  /** task-failed 时的简短原因（供气泡展示）。 */
  reason?: string;
}

/** 状态优先级：数值越高越"忙"，低优先级事件不能打断高优先级状态。 */
const PRIORITY: Record<PetState, number> = {
  working: 60,
  listening: 50,
  thinking: 40,
  success: 30,
  error: 30,
  idle: 10,
  sleeping: 0,
};

/** success/error 展示停留时长，之后自动回 idle。 */
const HOLD_MS = 2_500;
/** idle 多久无任务进入 sleeping。 */
const SLEEP_AFTER_MS = 90_000;

export class PetStateMachine {
  private _state: PetState = "idle";
  private lastErrorReason?: string;
  private readonly listeners = new Set<(change: PetStateChange) => void>();
  private holdTimer: NodeJS.Timeout | undefined;
  private sleepTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(opts: { holdMs?: number; sleepAfterMs?: number } = {}) {
    if (opts.holdMs !== undefined) this.holdMs = opts.holdMs;
    if (opts.sleepAfterMs !== undefined) this.sleepAfterMs = opts.sleepAfterMs;
    this.armSleepTimer();
  }

  private holdMs: number = HOLD_MS;
  private sleepAfterMs: number = SLEEP_AFTER_MS;

  get state(): PetState {
    return this._state;
  }

  get errorReason(): string | undefined {
    return this.lastErrorReason;
  }

  subscribe(listener: (change: PetStateChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispatch(event: PetEvent): PetState {
    if (this.disposed) return this._state;
    switch (event.type) {
      case "input-start": {
        // 输入开始：非工作状态都可进入聆听（不打断工作中的任务）
        if (this._state !== "working") {
          this.transitionTo("listening");
        }
        break;
      }
      case "input-end": {
        // 输入提交：listening → thinking（工作/思考中的提交不回退）
        if (this._state === "listening") {
          this.transitionTo("thinking");
        }
        break;
      }
      case "agent-start": {
        // Agent 真正开始执行：任何状态 → working
        this.transitionTo("working");
        break;
      }
      case "task-success": {
        // 任务成功（由结构化结果判定）：工作/思考中才有效
        if (this._state === "working" || this._state === "thinking") {
          this.transitionTo("success");
          this.armHoldTimer();
        }
        break;
      }
      case "task-failed": {
        if (this._state === "working" || this._state === "thinking") {
          this.lastErrorReason = event.reason;
          this.transitionTo("error");
          this.armHoldTimer();
        }
        break;
      }
      case "idle-timeout": {
        if (this._state === "idle") {
          this.transitionTo("sleeping");
        }
        break;
      }
      case "wake":
      case "reset": {
        if (this._state !== "idle") this.transitionTo("idle");
        break;
      }
    }
    return this._state;
  }

  /** 任务结束（CLI 层在 run 返回后调用）：按结构化结果分派成败。 */
  finishTask(ok: boolean, reason?: string): PetState {
    return this.dispatch(ok ? { type: "task-success" } : { type: "task-failed", reason });
  }

  dispose(): void {
    this.disposed = true;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.holdTimer = undefined;
    this.sleepTimer = undefined;
    this.listeners.clear();
  }

  private transitionTo(next: PetState): void {
    if (next === this._state) return; // 去重：相同状态不产生事件、不重置定时器
    const change: PetStateChange = { from: this._state, to: next, reason: next === "error" ? this.lastErrorReason : undefined };
    this._state = next;
    if (next === "idle") this.armSleepTimer();
    else this.disarmSleepTimer();
    for (const l of this.listeners) {
      try {
        l(change);
      } catch {
        // 监听器异常不影响状态机
      }
    }
  }

  private armHoldTimer(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => {
      this.holdTimer = undefined;
      // success/error 停留结束 → idle（若期间有更高优先级状态则此处 state 已变化，直接跳过）
      if (this._state === "success" || this._state === "error") this.transitionTo("idle");
    }, this.holdMs);
  }

  private armSleepTimer(): void {
    this.disarmSleepTimer();
    this.sleepTimer = setTimeout(() => {
      this.sleepTimer = undefined;
      this.dispatch({ type: "idle-timeout" });
    }, this.sleepAfterMs);
  }

  private disarmSleepTimer(): void {
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = undefined;
    }
  }
}
