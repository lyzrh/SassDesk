import { spawn } from "node:child_process";

/**
 * PowerShell 执行封装（受控：-NoProfile -NonInteractive，固定超时，可取消）。
 * 所有 Windows 系统操作必须经由本封装，禁止上层直接拼 shell 命令字符串交给 cmd。
 */

export interface PowerShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PowerShellRunner {
  run(script: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<PowerShellResult>;
}

/** UTF-8 前缀：保证中文输出不乱码（Windows PowerShell 5.1 默认 GBK 控制台编码）。 */
const ENCODING_PREAMBLE = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; `;

export class ChildPowerShellRunner implements PowerShellRunner {
  constructor(private readonly defaultTimeoutMs = 15_000) {}

  run(script: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<PowerShellResult> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ENCODING_PREAMBLE + script],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );

      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          child.kill();
          settled = true;
          reject(new Error(`PowerShell 执行超时（>${timeoutMs}ms）`));
        }
      }, timeoutMs);

      const onAbort = () => {
        if (!settled) {
          child.kill();
          settled = true;
          clearTimeout(timer);
          reject(new Error("PowerShell 执行已被取消"));
        }
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf-8");
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf-8");
      });
      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          reject(err);
        }
      });
      child.on("close", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          resolve({ stdout, stderr, exitCode: code ?? -1 });
        }
      });
    });
  }
}

/** 测试用假 runner：按脚本片段匹配返回预设结果。 */
export class FakePowerShellRunner implements PowerShellRunner {
  readonly calls: Array<{ script: string }> = [];

  constructor(private readonly responder: (script: string) => { stdout?: string; stderr?: string; exitCode?: number } | Error) {}

  run(script: string): Promise<PowerShellResult> {
    this.calls.push({ script });
    const r = this.responder(script);
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve({ stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 });
  }
}
