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
    // 幂等：Set-ItemProperty 覆盖已有值
    const script =
      `$null = New-Item -Path '${RUN_KEY}' -Force; ` +
      `Set-ItemProperty -Path '${RUN_KEY}' -Name '${entry}' -Value '${psEscape(command)}'; ` +
      `Write-Output 'ok'`;
    const { exitCode, stderr } = await this.ps.run(script, { timeoutMs: 10_000 });
    if (exitCode !== 0) {
      throw new Error(`注册开机启动失败：${stderr.slice(0, 300)}`);
    }
    return { name: entry, command };
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
