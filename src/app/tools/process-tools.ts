import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { SassDeskTool } from "../../agent/tools/types.js";
import type { ProcessProbe } from "../system/process/probe.js";
import type { AppLauncher } from "../system/process/runner.js";
import { listWhitelist, resolveAppPath, lookupInstalledAppExe, APP_WHITELIST } from "../system/windows/apps.js";
import type { PowerShellRunner } from "../system/windows/powershell.js";

/**
 * 进程查询（safe）与白名单应用启动（confirm）。
 * 启动链路：appId → 白名单条目 → 路径解析（配置/常见路径/注册表）→ 受控子进程。
 * 模型永远接触不到 shell 命令字符串。
 */

export function createProcessQueryTool(deps: { probe: ProcessProbe }): SassDeskTool<any> {
  const Params = Type.Object({
    processName: Type.String({ description: "进程名，例如 QQMusic、notepad" }),
  });
  const tool: SassDeskTool<typeof Params> = {
    name: "process_query",
    label: "查询进程状态",
    description: "查询指定进程是否正在运行。参数 processName 为进程名（可带或不带 .exe，例如 QQMusic）。",
    parameters: Params,
    dangerLevel: "safe",
    timeoutMs: 12_000,
    async execute(_id, params) {
      const infos = await deps.probe.findByName(params.processName);
      const running = infos.length > 0;
      const text = running
        ? `进程 ${params.processName} 正在运行（pid: ${infos.map((i) => i.id).join(", ")}）。`
        : `进程 ${params.processName} 当前未运行。`;
      return {
        content: [{ type: "text", text }],
        details: { processName: params.processName, running, pids: infos.map((i) => i.id) },
      };
    },
  };
  return tool;
}

export function createProcessStartTool(deps: { launcher: AppLauncher; ps: PowerShellRunner; overrides?: Record<string, string> }): SassDeskTool<any> {
  const appIds = listWhitelist().map((e) => e.appId);
  const Params = Type.Object({
    appId: StringEnum(appIds, { description: "白名单应用 ID" }),
  });
  const tool: SassDeskTool<typeof Params> = {
    name: "process_start",
    label: "启动白名单应用",
    description:
      `启动一个白名单内的应用。appId 只能是：${appIds.join(", ")}。` +
      "返回「启动命令已发送」状态；是否真实运行需要再用 process_query 确认。",
    parameters: Params,
    dangerLevel: "confirm",
    timeoutMs: 20_000,
    async execute(_id, params) {
      const entry = APP_WHITELIST[params.appId];
      if (!entry) {
        throw new Error(`应用 ${params.appId} 不在白名单中`);
      }
      const resolved = await resolveAppPath(params.appId, {
        overrides: deps.overrides,
        registryLookup: async (kw) => lookupInstalledAppExe(kw, entry.exe, deps.ps),
      });
      if (!resolved) {
        const text = `未找到「${entry.friendlyName}」的安装路径。请让用户在 config.json 中配置对应路径后重试。`;
        return { content: [{ type: "text", text }], details: { appId: params.appId, resolved: false }, isError: true };
      }
      const dispatched = await deps.launcher.start(resolved.exePath);
      const note =
        dispatched.dispatched
          ? `「${entry.friendlyName}」启动命令已发送（${resolved.exePath}，来源：${resolved.source}）。注意：这只代表命令已发送，不代表应用窗口已出现或内容已加载。`
          : `「${entry.friendlyName}」启动失败：${dispatched.detail}`;
      return {
        content: [{ type: "text", text: note }],
        details: { appId: params.appId, exePath: resolved.exePath, source: resolved.source, dispatched: dispatched.dispatched },
      };
    },
  };
  return tool;
}
