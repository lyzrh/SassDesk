import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * 应用白名单：模型只能通过 appId 启动这里登记的应用。
 * 白名单是代码内固件（模型不可修改）；新增应用 = 修改源码 + 用户确认。
 */

export interface WhitelistEntry {
  appId: string;
  friendlyName: string;
  exe: string;
  /** 常见安装路径（存在性探测顺序）。 */
  commonPaths: (env: NodeJS.ProcessEnv) => string[];
  /** 注册表 Uninstall 探测关键词。 */
  uninstallKeyword?: string;
}

export const APP_WHITELIST: Record<string, WhitelistEntry> = {
  qqmusic: {
    appId: "qqmusic",
    friendlyName: "QQ 音乐",
    exe: "QQMusic.exe",
    commonPaths: (env) => [
      "C:\\Program Files (x86)\\Tencent\\QQMusic\\QQMusic.exe",
      "C:\\Program Files\\Tencent\\QQMusic\\QQMusic.exe",
      path.join(env["LOCALAPPDATA"] ?? "", "Programs", "Tencent", "QQMusic", "QQMusic.exe"),
      path.join(env["APPDATA"] ?? "", "Tencent", "QQMusic", "QQMusic.exe"),
    ],
    uninstallKeyword: "QQ音乐",
  },
  notepad: {
    appId: "notepad",
    friendlyName: "记事本",
    exe: "notepad.exe",
    commonPaths: () => ["C:\\Windows\\System32\\notepad.exe", "C:\\Windows\\notepad.exe"],
  },
  mspaint: {
    appId: "mspaint",
    friendlyName: "画图",
    exe: "mspaint.exe",
    commonPaths: () => ["C:\\Windows\\System32\\mspaint.exe"],
  },
  calc: {
    appId: "calc",
    friendlyName: "计算器",
    exe: "calc.exe",
    commonPaths: () => ["C:\\Windows\\System32\\calc.exe"],
  },
};

export function listWhitelist(): WhitelistEntry[] {
  return Object.values(APP_WHITELIST);
}

export interface ResolvedApp {
  appId: string;
  exePath: string;
  source: "config" | "common-path" | "registry";
}

/**
 * 解析应用真实路径：
 * 1) 用户配置路径（config.music.qqmusicPath 等，由调用方传入 overrides）
 * 2) 常见安装路径存在性探测
 * 3) 注册表 Uninstall 键（QQ 音乐等 GUI 应用）
 */
export async function resolveAppPath(
  appId: string,
  opts: { overrides?: Record<string, string>; registryLookup?: (keyword: string) => Promise<string | null> } = {},
): Promise<ResolvedApp | null> {
  const entry = APP_WHITELIST[appId];
  if (!entry) return null;

  const override = opts.overrides?.[appId];
  if (override && override.trim() !== "") {
    const p = path.resolve(override.trim());
    if (fs.existsSync(p)) return { appId, exePath: p, source: "config" };
    // 配置的路径不存在：继续探测，但调用方需在结果中提示
  }

  for (const candidate of entry.commonPaths(process.env)) {
    if (candidate && fs.existsSync(candidate)) {
      return { appId, exePath: candidate, source: "common-path" };
    }
  }

  if (entry.uninstallKeyword && opts.registryLookup) {
    const fromRegistry = await opts.registryLookup(entry.uninstallKeyword);
    if (fromRegistry && fs.existsSync(fromRegistry)) {
      return { appId, exePath: fromRegistry, source: "registry" };
    }
  }

  return null;
}

/** 从注册表 Uninstall 键查找应用主程序（PowerShell 实现，返回 exe 全路径或 null）。 */
export async function lookupInstalledAppExe(keyword: string, exeName: string, ps: import("../windows/powershell.js").PowerShellRunner): Promise<string | null> {
  const safeKeyword = keyword.replace(/'/g, "''");
  const safeExe = exeName.replace(/\\/g, "\\\\").replace(/'/g, "''");
  const script =
    `$keys = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); ` +
    `$hits = Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { ($_.DisplayName -like '*${safeKeyword}*') -and $_.InstallLocation }; ` +
    `if ($hits) { $loc = ($hits | Select-Object -First 1).InstallLocation.TrimEnd('\\'); $exe = Join-Path $loc '${safeExe}'; if (Test-Path $exe) { Write-Output $exe } else { Write-Output '' } } else { Write-Output '' }`;
  const { stdout } = await ps.run(script, { timeoutMs: 15_000 });
  const trimmed = stdout.trim();
  return trimmed === "" ? null : trimmed;
}

/** 平台守卫：非 Windows 环境直接报错（CI/测试可注入 fake 适配器绕过）。 */
export function assertWindows(): void {
  if (os.platform() !== "win32") {
    throw new Error("SassDesk v0.1.0 的系统工具仅支持 Windows 平台");
  }
}
