import fs from "node:fs";
import { VoiceError } from "../types.js";
import type { VoiceCaptureResult } from "../types.js";

/**
 * Whisper 兼容云端识别 Provider（OpenAI /v1/audio/transcriptions 协议）。
 * - 输入：已存在的 WAV/MP3 文件（v0.1.0 不内置录音器，避免引入 ffmpeg/sox 依赖；录音可用系统录音机等外部工具产出文件）；
 * - 隐私说明：音频会上传到 sttBaseUrl 指向的第三方服务，CLI 触发时会明确提示；
 * - Key：SASSDESK_STT_API_KEY > SASSDESK_API_KEY > OPENAI_API_KEY。
 */

export interface WhisperSttOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 可选自定义语言，默认 zh。 */
  language?: string;
}

export class WhisperSttProvider {
  readonly id = "whisper";

  constructor(private readonly opts: WhisperSttOptions) {}

  async transcribeFile(wavPath: string, signal?: AbortSignal): Promise<VoiceCaptureResult> {
    if (!this.opts.baseUrl) {
      throw new VoiceError('未配置语音识别服务地址。请在 config.json 设置 voice.sttBaseUrl（例如 https://api.openai.com/v1）。', "provider");
    }
    if (!this.opts.apiKey) {
      throw new VoiceError("未配置语音识别 API Key。请在 .env 设置 SASSDESK_STT_API_KEY。", "provider");
    }
    let audio: Buffer;
    try {
      audio = fs.readFileSync(wavPath);
    } catch {
      throw new VoiceError(`无法读取音频文件：${wavPath}`, "provider");
    }

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), wavPath.replace(/\\/g, "/").split("/").pop() ?? "audio.wav");
    form.append("model", this.opts.model);
    if (this.opts.language) form.append("language", this.opts.language);

    let resp: Response;
    try {
      resp = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        body: form,
        signal,
      });
    } catch (e) {
      throw new VoiceError(`语音识别网络请求失败：${(e as Error).message}`, "network");
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new VoiceError(`语音识别服务返回 ${resp.status}：${body.slice(0, 200)}`, "provider");
    }
    const data = (await resp.json()) as { text?: string };
    const text = (data.text ?? "").trim();
    if (text === "") throw new VoiceError("语音识别服务未返回文本。", "provider");
    return {
      text,
      providerId: this.id,
      mock: false,
      detail: `Whisper 兼容服务识别（模型 ${this.opts.model}）。注意：该模式会把音频上传到 ${this.opts.baseUrl}。`,
    };
  }
}

/** 从文本输入转写（CLI /voice-file 命令用）。 */
export async function transcribeWithWhisper(opts: WhisperSttOptions, wavPath: string, signal?: AbortSignal): Promise<VoiceCaptureResult> {
  return new WhisperSttProvider(opts).transcribeFile(wavPath, signal);
}
