/**
 * 语音输入管线契约（P1）。
 * 设计约束：
 * - 语音识别不进 Agent Core：管线产出文本后走与文本输入完全相同的 Agent 入口；
 * - Provider 接口隔离，云端/本地实现可替换；
 * - 结果必须如实标注 mock（模拟）与真实识别，禁止把模拟结果冒充真实识别。
 */

export interface VoiceCaptureResult {
  text: string;
  providerId: string;
  /** true 表示这是模拟结果（未经过真实语音识别）。 */
  mock: boolean;
  /** 采集细节（设备、耗时、错误说明等），用于 CLI 展示与排错。 */
  detail: string;
}

export interface VoiceCapture {
  readonly id: string;
  /** 阻塞式采集：按键触发后由实现负责录音/识别，直到产出文本或失败。 */
  capture(opts: { maxSeconds: number; signal?: AbortSignal }): Promise<VoiceCaptureResult>;
}

export class VoiceError extends Error {
  constructor(
    message: string,
    readonly kind: "no-device" | "no-recognizer" | "timeout" | "network" | "cancelled" | "provider",
  ) {
    super(message);
    this.name = "VoiceError";
  }
}
