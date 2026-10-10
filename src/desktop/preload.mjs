// Electron preload（CJS-free：渲染进程通过 contextBridge 拿到唯一受控 API）
// 此文件被构建脚本原样复制到 dist/desktop/preload.mjs（Electron ESM preload 要求 .mjs 扩展名）。
import { contextBridge, ipcRenderer } from "electron";

console.log("[preload] executing, sandbox context ok");
contextBridge.exposeInMainWorld("sassdesk", {
  /** 主进程推送角色配置（manifest + 素材目录 file URL）。 */
  onConfig: (cb) => ipcRenderer.on("pet:config", (_e, data) => cb(data)),
  /** 主进程推送状态变化。 */
  onState: (cb) => ipcRenderer.on("pet:state", (_e, data) => cb(data)),
  /** 主进程推送气泡文本（状态说明 / Agent 回复摘要）。 */
  onBubble: (cb) => ipcRenderer.on("pet:bubble", (_e, data) => cb(data)),
  /** 对话输入窗提交文本（仅输入窗使用）。 */
  submit: (text) => ipcRenderer.invoke("input:submit", text),
});
