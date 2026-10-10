import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 路径解析：全部集中在这里，方便测试注入与替换。
 */

/** 项目根目录（src/.. 编译后为 dist/..，均落在仓库根）。 */
export function projectRoot(): string {
  // dist/shared/paths.js → 上两级；src 直接跑时同理
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** 解析 SassDesk 数据目录（偏好、规则、执行记录）。 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["SASSDESK_DATA_DIR"];
  if (override && override.trim() !== "") return path.resolve(override);
  return path.join(projectRoot(), "data");
}

/** 解析配置文件搜索目录：优先环境变量，否则项目根。 */
export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["SASSDESK_CONFIG_DIR"];
  if (override && override.trim() !== "") return path.resolve(override);
  return projectRoot();
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
