import { Type } from "typebox";
import os from "node:os";
import type { SassDeskTool } from "../../agent/tools/types.js";

/**
 * 环境信息工具（safe，只读）：让 Agent 知道自己运行在哪台机器上。
 */

export function createEnvInfoTool(deps: { dataDir: string; configPath: string }): SassDeskTool<any> {
  const Params = Type.Object({});
  const tool: SassDeskTool<typeof Params> = {
    name: "env_info",
    label: "查看运行环境",
    description: "获取当前操作系统、Node 运行时与 SassDesk 数据目录信息。无参数。",
    parameters: Params,
    dangerLevel: "safe",
    timeoutMs: 5_000,
    async execute() {
      const info = {
        platform: os.platform(),
        osType: os.type(),
        osRelease: os.release(),
        arch: os.arch(),
        nodeVersion: process.version,
        hostname: os.hostname(),
        username: os.userInfo().username,
        dataDir: deps.dataDir,
        configPath: deps.configPath,
      };
      const text =
        `操作系统：${info.osType} ${info.osRelease}（${info.platform}-${info.arch}）\n` +
        `Node.js：${info.nodeVersion}\n` +
        `主机名：${info.hostname}，用户：${info.username}\n` +
        `数据目录：${info.dataDir}`;
      return { content: [{ type: "text" as const, text }], details: info };
    },
  };
  return tool;
}
