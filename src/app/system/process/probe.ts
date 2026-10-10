/**
 * 进程探测（只读，safe 级）。
 * PowerShell Get-Process 输出 CSV 解析，避免中文/特殊字符干扰。
 */

export interface ProcessInfo {
  name: string;
  id: number;
}

export interface ProcessProbe {
  /** 查询指定进程名（不含 .exe 也可）是否在运行。 */
  findByName(processName: string): Promise<ProcessInfo[]>;
}

function normalizeName(name: string): string {
  return name.replace(/\.exe$/i, "").trim();
}

export class PowerShellProcessProbe implements ProcessProbe {
  constructor(private readonly ps: import("../windows/powershell.js").PowerShellRunner) {}

  async findByName(processName: string): Promise<ProcessInfo[]> {
    const name = normalizeName(processName);
    if (!/^[A-Za-z0-9_. -]{1,64}$/.test(name)) {
      throw new Error(`非法进程名：${processName}`);
    }
    const script =
      `Get-Process -Name @('${name}') -ErrorAction SilentlyContinue | ` +
      `Select-Object -Property ProcessName,Id | ConvertTo-Csv -NoTypeInformation`;
    const { stdout } = await this.ps.run(script, { timeoutMs: 10_000 });
    return parseProcessCsv(stdout);
  }
}

/** 解析 ConvertTo-Csv 输出（首行 header，字段均为 "value" 形式）。 */
export function parseProcessCsv(stdout: string): ProcessInfo[] {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const result: ProcessInfo[] = [];
  for (const line of lines.slice(1)) {
    const fields = splitCsvFields(line);
    const name = fields[0] ?? "";
    const id = Number.parseInt(fields[1] ?? "", 10);
    if (name !== "" && Number.isFinite(id)) {
      result.push({ name, id });
    }
  }
  return result;
}

/** 把一行 CSV（字段形如 "..."）切分为字段值数组。 */
export function splitCsvFields(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}
