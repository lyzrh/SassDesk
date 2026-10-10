/**
 * 极简 .env 加载器（KEY=VALUE / 注释 / 引号），避免为一个小功能引入 dotenv 依赖。
 * 只填充尚未定义的环境变量，不覆盖已有值。
 */
import fs from "node:fs";
import path from "node:path";

export function loadDotEnvFile(file: string, env: NodeJS.ProcessEnv = process.env): number {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return 0;
  }
  let applied = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key in env && env[key] !== undefined && env[key] !== "") continue;
    env[key] = value;
    applied += 1;
  }
  return applied;
}

/** 依次尝试项目根与当前目录的 .env。 */
export function loadDotEnv(configDir: string, cwd: string = process.cwd()): void {
  loadDotEnvFile(path.join(configDir, ".env"));
  if (path.resolve(cwd) !== path.resolve(configDir)) loadDotEnvFile(path.join(cwd, ".env"));
}
