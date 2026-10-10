/**
 * Windows Startup Provider：
 * - HKCU\Software\Microsoft\Windows\CurrentVersion\Run（无需管理员，用户级，透明可撤销）
 * - 幂等：重复注册时更新同名值
 * - 接口化：测试用 InMemoryStartupProvider，绝不真实改动用户注册表
 */

export interface StartupStatus {
  name: string;
  command: string;
}

export interface StartupProvider {
  /** 查询注册状态；未注册返回 undefined。 */
  getStatus(name: string): Promise<StartupStatus | undefined>;
  /** 注册/更新开机启动项（幂等）。 */
  register(name: string, command: string): Promise<StartupStatus>;
  /** 撤销注册；不存在时静默成功。返回是否真实删除了条目。 */
  unregister(name: string): Promise<boolean>;
}

const RUN_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

function sanitizeEntryName(name: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error(`非法启动项名称：${name}`);
  }
  return name;
}

function psEscape(s: string): string {
  return s.replace(/'/g, "''");
}

export class HkcuRunStartupProvider implements StartupProvider {
  constructor(private readonly ps: import("../windows/powershell.js").PowerShellRunner) {}

  async getStatus(name: string): Promise<StartupStatus | undefined> {
    const entry = sanitizeEntryName(name);
    const script = `$v = (Get-ItemProperty -Path '${RUN_KEY}' -ErrorAction SilentlyContinue).'${entry}'; if ($null -ne $v) { Write-Output $v }`;
    const { stdout } = await this.ps.run(script, { timeoutMs: 10_000 });
    const command = stdout.trim();
    return command === "" ? undefined : { name: entry, command };
  }

  async register(name: string, command: string): Promise<StartupStatus> {
    const entry = sanitizeEntryName(name);
    if (command.trim() === "") throw new Error("启动命令不能为空");
    // 幂等：键已存在时不重建（New-Item -Force 对已存在的 Run 键会报 data area too small），只覆盖属性值
    const script =
      `$runKey = '${RUN_KEY}'; ` +
      `if (-not (Test-Path $runKey)) { $null = New-Item -Path $runKey }; ` +
      `Set-ItemProperty -Path $runKey -Name '${entry}' -Value '${psEscape(command)}'; ` +
      `Write-Output 'ok'`;
    const { exitCode, stderr } = await this.ps.run(script, { timeoutMs: 10_000 });
    if (exitCode !== 0) {
      throw new Error(`注册开机启动失败：${stderr.slice(0, 300)}`);
    }
    // 写后读回校验：Set-ItemProperty 在某些受控环境会静默失败（看似 exitCode 0 但值未落盘）。
    // 读不回就明确报错，绝不把「命令已发送」伪装成「注册成功」。
    const verify = await this.getStatus(name);
    if (!verify || verify.command !== command) {
      throw new Error(
        "注册开机启动失败：Set-ItemProperty 已执行，但注册表中读不到刚写入的值。" +
          "常见原因：当前进程运行在限制注册表写入的沙箱/受控环境中。" +
          "请在真实终端（非沙箱）中重试，或手动运行：reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v " +
          `${entry} /t REG_SZ /d "${command}" /f`,
      );
    }
    return verify;
  }

  async unregister(name: string): Promise<boolean> {
    const entry = sanitizeEntryName(name);
    const script = `Remove-ItemProperty -Path '${RUN_KEY}' -Name '${entry}' -ErrorAction SilentlyContinue; Write-Output 'ok'`;
    const { exitCode } = await this.ps.run(script, { timeoutMs: 10_000 });
    if (exitCode !== 0) throw new Error("撤销开机启动失败");
    // 幂等语义：无论之前是否存在都视为成功
    return true;
  }
}

/** 内存实现（单元/集成测试用）。 */
export class InMemoryStartupProvider implements StartupProvider {
  readonly entries = new Map<string, string>();
  /** 注册操作历史（供测试断言）。 */
  readonly history: Array<{ op: "register" | "unregister"; name: string; command?: string; at: string }> = [];

  async getStatus(name: string): Promise<StartupStatus | undefined> {
    const command = this.entries.get(sanitizeEntryName(name));
    return command === undefined ? undefined : { name, command };
  }

  async register(name: string, command: string): Promise<StartupStatus> {
    const entry = sanitizeEntryName(name);
    if (command.trim() === "") throw new Error("启动命令不能为空");
    this.entries.set(entry, command);
    this.history.push({ op: "register", name: entry, command, at: new Date().toISOString() });
    return { name: entry, command };
  }

  async unregister(name: string): Promise<boolean> {
    const entry = sanitizeEntryName(name);
    const existed = this.entries.delete(entry);
    this.history.push({ op: "unregister", name: entry, at: new Date().toISOString() });
    return existed;
  }
}
