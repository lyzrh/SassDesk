import type { VoiceCapture, VoiceCaptureResult } from "../types.js";

/**
 * 模拟语音 Provider（测试/演示用）。
 * 返回固定文本并显式标注 mock=true——绝不冒充真实识别。
 */
export class MockVoiceCapture implements VoiceCapture {
  readonly id = "mock";

  constructor(private readonly cannedText = "帮我打开 QQ 音乐") {}

  async capture(): Promise<VoiceCaptureResult> {
    return {
      text: this.cannedText,
      providerId: this.id,
      mock: true,
      detail: "模拟语音 Provider：未进行任何真实录音或识别，返回预置文本。",
    };
  }
}
