import { Type } from "typebox";
import type { SassDeskTool } from "../../agent/tools/types.js";
import type { QQMusicLauncher } from "../music/qqmusic.js";
import { QQMUSIC_PLAYBACK_LIMITATION } from "../music/qqmusic.js";

/**
 * QQ 音乐专用工具：状态查询（safe）与客户端启动（confirm）。
 * 启动结果区分「命令已发送」与「进程已确认」，播放限制如实注入。
 */

export function createQQMusicStatusTool(deps: { qqmusic: QQMusicLauncher }): SassDeskTool<any> {
  const Params = Type.Object({});
  const tool: SassDeskTool<typeof Params> = {
    name: "qqmusic_status",
    label: "查询 QQ 音乐状态",
    description: "查询 QQ 音乐客户端进程状态与安装路径解析结果。无参数。",
    parameters: Params,
    dangerLevel: "safe",
    timeoutMs: 15_000,
    async execute() {
      const procs = await deps.qqmusic.runningProcesses();
      const exePath = await deps.qqmusic.resolveExePath();
      const lines = [
        procs.length > 0 ? `客户端正在运行（pid: ${procs.map((p) => p.id).join(", ")}）。` : "客户端未运行。",
        exePath ? `安装路径：${exePath}` : "安装路径：未找到（可在 config.json 的 music.qqmusicPath 配置）。",
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { running: procs.length > 0, pids: procs.map((p) => p.id), exePath },
      };
    },
  };
  return tool;
}

export function createQQMusicStartTool(deps: { qqmusic: QQMusicLauncher }): SassDeskTool<any> {
  const Params = Type.Object({});
  const tool: SassDeskTool<typeof Params> = {
    name: "qqmusic_start",
    label: "启动 QQ 音乐",
    description:
      "启动 QQ 音乐客户端并等待确认进程出现。无参数。" +
      "注意：该工具只能启动客户端，不能控制播放指定歌曲/歌单（QQ 音乐无公开本地播放接口）。",
    parameters: Params,
    dangerLevel: "confirm",
    timeoutMs: 45_000,
    async execute() {
      const result = await deps.qqmusic.start();
      const text = `${result.message}\n${QQMUSIC_PLAYBACK_LIMITATION}`;
      return {
        content: [{ type: "text", text }],
        details: {
          phase: result.phase,
          processConfirmed: result.processConfirmed,
          clientRunning: result.clientRunning,
          exePath: result.exePath,
          pids: result.pids,
        },
      };
    },
  };
  return tool;
}
