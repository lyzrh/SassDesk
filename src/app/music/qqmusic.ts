import type { ProcessProbe } from "../system/process/probe.js";
import type { AppLauncher } from "../system/process/runner.js";
import { resolveAppPath, lookupInstalledAppExe, APP_WHITELIST } from "../system/windows/apps.js";
import type { PowerShellRunner } from "../system/windows/powershell.js";

/**
 * QQ 音乐启动器。
 * 重要事实边界（v0.1.0）：
 * - 「启动 QQ 音乐客户端」= 发送启动命令 + 进程探测确认（phase=launched 且 processConfirmed）；
 * - 「播放指定歌曲」QQ 音乐没有公开的本地控制接口，v0.1.0 不承诺、不伪造成功。
 *   反馈给用户的文案必须区分这两个事实。
 */

export const QQMUSIC_PROCESS_NAME = "QQMusic";

export interface QQMusicStartResult {
  /** already-running：客户端已在运行；launched：本次发起启动；failed：失败。 */
  phase: "already-running" | "launched" | "failed";
  /** 发送启动命令后，进程是否真实出现（launched 时才有意义）。 */
  processConfirmed: boolean;
  exePath?: string;
  pids: number[];
  /** 面向用户的中文如实说明。 */
  message: string;
  /** 是否满足「客户端已启动」判据（含原本就在运行的情况）。 */
  clientRunning: boolean;
}

export interface QQMusicStartOptions {
  /** 发送命令后等待进程出现的总时长（毫秒），默认 8000。 */
  waitMs?: number;
  /** 轮询间隔（毫秒），默认 1000。 */
  pollIntervalMs?: number;
}

export class QQMusicLauncher {
  private readonly defaultWaitMs: number;
  private readonly defaultPollIntervalMs: number;

  constructor(
    private readonly probe: ProcessProbe,
    private readonly launcher: AppLauncher,
    private readonly ps: PowerShellRunner,
    private readonly configuredPath = "",
    opts: QQMusicStartOptions = {},
  ) {
    this.defaultWaitMs = opts.waitMs ?? 8_000;
    this.defaultPollIntervalMs = opts.pollIntervalMs ?? 1_000;
  }

  /** 当前客户端进程列表。 */
  async runningProcesses(): Promise<Array<{ id: number }>> {
    const infos = await this.probe.findByName(QQMUSIC_PROCESS_NAME);
    return infos.map((i) => ({ id: i.id }));
  }

  /** 解析 QQ 音乐可执行文件路径（用户配置 > 常见路径 > 注册表）。 */
  async resolveExePath(): Promise<string | null> {
    const resolved = await resolveAppPath("qqmusic", {
      overrides: { qqmusic: this.configuredPath },
      registryLookup: async (keyword) => lookupInstalledAppExe(keyword, APP_WHITELIST["qqmusic"]!.exe, this.ps),
    });
    return resolved?.exePath ?? null;
  }

  /**
   * 启动 QQ 音乐客户端并验证进程出现。
   * waitMs：发送命令后等待进程出现的时间（默认 8000ms，按轮询间隔探测）。
   */
  async start(opts: QQMusicStartOptions = {}): Promise<QQMusicStartResult> {
    const waitMs = opts.waitMs ?? this.defaultWaitMs;
    const pollIntervalMs = opts.pollIntervalMs ?? this.defaultPollIntervalMs;

    const existing = await this.probe.findByName(QQMUSIC_PROCESS_NAME);
    if (existing.length > 0) {
      return {
        phase: "already-running",
        processConfirmed: true,
        pids: existing.map((e) => e.id),
        clientRunning: true,
        message: `QQ 音乐客户端已在运行（pid: ${existing.map((e) => e.id).join(", ")}）。`,
      };
    }

    const exePath = await this.resolveExePath();
    if (!exePath) {
      return {
        phase: "failed",
        processConfirmed: false,
        pids: [],
        clientRunning: false,
        message:
          "未找到 QQ 音乐安装路径。请在 config.json 的 music.qqmusicPath 填入 QQMusic.exe 完整路径后重试" +
          "（例如 C:\\Program Files (x86)\\Tencent\\QQMusic\\QQMusic.exe）。",
      };
    }

    const dispatched = await this.launcher.start(exePath);
    if (!dispatched.dispatched) {
      return {
        phase: "failed",
        processConfirmed: false,
        exePath,
        pids: [],
        clientRunning: false,
        message: `启动命令未成功发送：${dispatched.detail}`,
      };
    }

    // 轮询验证进程真实出现（命令已发送 ≠ 启动成功）
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      const now = await this.probe.findByName(QQMUSIC_PROCESS_NAME);
      if (now.length > 0) {
        return {
          phase: "launched",
          processConfirmed: true,
          exePath,
          pids: now.map((e) => e.id),
          clientRunning: true,
          message: `QQ 音乐客户端已启动（${exePath}，pid: ${now.map((e) => e.id).join(", ")}）。注意：这只代表客户端已运行，不代表已开始播放任何歌曲。`,
        };
      }
    }

    return {
      phase: "launched",
      processConfirmed: false,
      exePath,
      pids: [],
      clientRunning: false,
      message: `启动命令已发送（${exePath}），但等待 ${Math.round(waitMs / 1000)} 秒后未检测到 QQMusic 进程。客户端可能启动失败或仍在加载，请人工确认。`,
    };
  }
}

/** 播放限制说明（给 LLM 与用户的固定事实）。 */
export const QQMUSIC_PLAYBACK_LIMITATION =
  "QQ 音乐没有公开的本地播放控制接口，SassDesk v0.1.0 只能可靠地启动 QQ 音乐客户端并确认进程运行，无法保证自动播放指定歌曲或歌单。请如实告知用户这一限制。";
