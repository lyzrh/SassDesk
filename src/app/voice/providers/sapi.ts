import type { PowerShellRunner } from "../../system/windows/powershell.js";
import { VoiceError } from "../types.js";
import type { VoiceCapture, VoiceCaptureResult } from "../types.js";

/**
 * Windows SAPI 本地语音识别 Provider（System.Speech，中文优先）。
 * - 完全本地：音频不上传任何第三方服务；
 * - 依赖：Windows 已安装中文语音识别引擎（设置 → 时间和语言 → 语音 → 添加语音）；
 * - 流程：按键触发 → 麦克风采集 → 静音判定结束 → 输出文本。
 */

const MARKER_OK = "SASSDESK_STT_OK:";
const MARKER_ERROR = "SASSDESK_STT_ERROR:";

export class SapiVoiceCapture implements VoiceCapture {
  readonly id = "sapi";

  constructor(private readonly ps: PowerShellRunner) {}

  async capture(opts: { maxSeconds: number; signal?: AbortSignal }): Promise<VoiceCaptureResult> {
    const maxSeconds = Math.min(Math.max(2, Math.round(opts.maxSeconds)), 120);
    const script = buildSapiScript(maxSeconds);
    let result: { stdout: string; stderr: string; exitCode: number };
    try {
      result = await this.ps.run(script, { timeoutMs: (maxSeconds + 30) * 1000, signal: opts.signal });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      throw new VoiceError(msg.includes("取消") ? "采集已被用户取消" : `SAPI 语音识别执行失败：${msg}`, msg.includes("取消") ? "cancelled" : "provider");
    }

    const stdout = result.stdout.trim();
    if (stdout.includes(MARKER_ERROR)) {
      const reason = stdout.split(MARKER_ERROR)[1]?.trim() ?? "unknown";
      if (reason === "no-recognizer") {
        throw new VoiceError(
          "未检测到中文语音识别引擎。请在 Windows 设置 → 时间和语言 → 语音/语言中添加中文语音识别功能后重试；或在 config.json 将 voice.provider 改为 whisper（云端）。",
          "no-recognizer",
        );
      }
      if (reason === "no-input") {
        throw new VoiceError("无法访问默认麦克风。请检查麦克风连接与 Windows 麦克风隐私权限。", "no-device");
      }
      throw new VoiceError(`SAPI 识别失败：${reason}`, "provider");
    }
    if (stdout.includes(MARKER_OK)) {
      const text = (stdout.split(MARKER_OK)[1] ?? "").trim();
      if (text === "") {
        throw new VoiceError("未识别到有效语音（录音时段内没有可辨识的内容）。请重试并适当延长说话时间。", "timeout");
      }
      return { text, providerId: this.id, mock: false, detail: "Windows SAPI 本地识别（音频未离开本机）" };
    }
    throw new VoiceError(`SAPI 输出异常：${stdout.slice(0, 200) || "(空)"}`, "provider");
  }
}

function buildSapiScript(maxSeconds: number): string {
  return [
    `Add-Type -AssemblyName System.Speech;`,
    `$recognizers = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers();`,
    `$zh = $recognizers | Where-Object { $_.Culture.Name -like 'zh*' } | Select-Object -First 1;`,
    `if (-not $zh) { Write-Output '${MARKER_ERROR}no-recognizer'; exit }`,
    `try {`,
    `  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($zh.ID);`,
    `  $engine.SetInputToDefaultAudioDevice();`,
    `} catch { Write-Output '${MARKER_ERROR}no-input'; exit }`,
    `$grammar = New-Object System.Speech.Recognition.DictationGrammar;`,
    `$engine.LoadGrammar($grammar);`,
    `$engine.BabbleTimeout = [TimeSpan]::FromSeconds(3);`,
    `$engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(5);`,
    `$engine.EndSilenceTimeout = [TimeSpan]::FromSeconds(1.2);`,
    `$result = $null;`,
    `try { $result = $engine.Recognize([TimeSpan]::FromSeconds(${maxSeconds})); } catch { Write-Output '${MARKER_ERROR}' + $_.Exception.Message; exit }`,
    `finally { $engine.Dispose(); }`,
    `if ($result -and $result.Text) { Write-Output '${MARKER_OK}' + $result.Text }`,
    `else { Write-Output '${MARKER_OK}' }`,
  ].join(" ");
}
