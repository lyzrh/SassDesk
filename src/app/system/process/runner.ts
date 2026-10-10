import { spawn } from "node:child_process";
import path from "node:path";

/**
 * 受控应用启动器：
 * - 只允许启动白名单解析出的绝对路径（由调用方——白名单模块——保证）；
 * - detached + unref 启动 GUI 应用，不接管其生命周期；
 * - 返回「命令已发送」事实，进程是否真实出现由 ProcessProbe 二次验证。
 */

export interface AppLauncher {
  /** 启动一个可执行文件。返回发送状态（不代表应用已成功运行）。 */
  start(exePath: string, args?: string[]): Promise<{ dispatched: boolean; detail: string }>;
}

export class ChildAppLauncher implements AppLauncher {
  async start(exePath: string, args: string[] = []): Promise<{ dispatched: boolean; detail: string }> {
    if (!path.isAbsolute(exePath)) {
      return { dispatched: false, detail: `拒绝启动相对路径程序：${exePath}` };
    }
    return new Promise((resolve) => {
      try {
        const child = spawn(exePath, args, { detached: true, stdio: "ignore", windowsHide: false, cwd: path.dirname(exePath) });
        child.on("error", (err) => {
          resolve({ dispatched: false, detail: `启动命令失败：${err.message}` });
        });
        // spawn 成功即认为命令已发送；unref 让 CLI 不等待 GUI 程序退出
        child.unref();
        resolve({ dispatched: true, detail: `启动命令已发送（pid=${child.pid ?? "unknown"}）` });
      } catch (err) {
        resolve({ dispatched: false, detail: `启动命令异常：${(err as Error).message}` });
      }
    });
  }
}
