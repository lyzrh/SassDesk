import { describe, it, expect } from "vitest";
import { MockVoiceCapture } from "../../src/app/voice/providers/mock.js";
import { createEventBridge } from "../../src/agent/core/events.js";
import { VoiceError } from "../../src/app/voice/types.js";
import { WhisperSttProvider } from "../../src/app/voice/providers/whisper.js";
import { ChildPowerShellRunner } from "../../src/app/system/windows/powershell.js";

describe("voice/providers/mock", () => {
  it("返回预置文本并显式标注 mock", async () => {
    const capture = new MockVoiceCapture("测试语音");
    const result = await capture.capture({ maxSeconds: 5 });
    expect(result.mock).toBe(true);
    expect(result.text).toBe("测试语音");
    expect(result.detail).toContain("模拟");
  });
});

describe("voice/providers/whisper（仅校验前置条件，不发真实请求）", () => {
  it("缺 baseUrl 时抛 VoiceError", async () => {
    const provider = new WhisperSttProvider({ baseUrl: "", model: "whisper-1", apiKey: "k" });
    await expect(provider.transcribeFile("a.wav")).rejects.toMatchObject({ kind: "provider" });
  });

  it("缺 apiKey 时抛 VoiceError", async () => {
    const provider = new WhisperSttProvider({ baseUrl: "https://example.invalid/v1", model: "whisper-1", apiKey: "" });
    await expect(provider.transcribeFile("a.wav")).rejects.toMatchObject({ kind: "provider" });
  });

  it("文件不存在时抛 VoiceError", async () => {
    const provider = new WhisperSttProvider({ baseUrl: "https://example.invalid/v1", model: "whisper-1", apiKey: "k" });
    await expect(provider.transcribeFile("Z:/no/such/file.wav")).rejects.toMatchObject({ kind: "provider" });
  });
});

describe("voice/types", () => {
  it("VoiceError 携带分类", () => {
    const e = new VoiceError("x", "no-device");
    expect(e.kind).toBe("no-device");
    expect(e.name).toBe("VoiceError");
  });
});

describe("agent/core/events 事件桥", () => {
  it("分类分发 text_delta / tool_start / tool_end / turn_end / run_end", () => {
    const seen: string[] = [];
    const bridge = createEventBridge({
      onTextDelta: (d) => seen.push(`text:${d}`),
      onToolStart: ({ toolName }) => seen.push(`start:${toolName}`),
      onToolEnd: ({ toolName }) => seen.push(`end:${toolName}`),
      onTurnEnd: ({ index }) => seen.push(`turn:${index}`),
      onRunEnd: () => seen.push("runend"),
    });
    bridge({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "你好" } } as never);
    bridge({ type: "tool_execution_start", toolCallId: "1", toolName: "qqmusic_start", args: {} } as never);
    bridge({ type: "tool_execution_end", toolCallId: "1", toolName: "qqmusic_start", result: { content: [] }, isError: false } as never);
    bridge({ type: "turn_end", message: {}, toolResults: [] } as never);
    bridge({ type: "agent_end", messages: [] } as never);
    expect(seen).toEqual(["text:你好", "start:qqmusic_start", "end:qqmusic_start", "turn:1", "runend"]);
  });
});

describe("system/windows/powershell 假 runner 可注入", () => {
  it("FakePowerShellRunner 记录调用并返回预设结果", async () => {
    const calls: string[] = [];
    const fake = {
      calls,
      async run(script: string) {
        calls.push(script);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
    } as unknown as ChildPowerShellRunner;
    const r = await fake.run("Get-Date");
    expect(r.stdout).toBe("ok");
    expect(calls).toHaveLength(1);
  });
});
