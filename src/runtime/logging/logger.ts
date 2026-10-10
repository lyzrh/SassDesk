import path from "node:path";
import pino from "pino";
import type { LoggingConfig } from "../config/schema.js";
import { ensureDir } from "../../shared/paths.js";

/**
 * 结构化日志（pino）。
 * v0.1.0 默认写文件（logs/sassdesk-YYYY-MM-DD.log），避免污染 CLI 交互界面。
 * 敏感字段（apiKey/token/authorization）统一 redact。
 */

export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

const REDACT_PATHS = ["apiKey", "api_key", "token", "authorization", "Authorization", "*.apiKey", "*.token", "req.headers.authorization"];

export function createLogger(cfg: LoggingConfig, opts: { cwd?: string; projectRoot?: string } = {}): Logger {
  const root = opts.projectRoot ?? process.cwd();
  const dir = path.isAbsolute(cfg.dir) ? cfg.dir : path.join(root, cfg.dir);
  try {
    ensureDir(dir);
  } catch {
    // 日志目录创建失败不致命：退回 stderr
    return pino({ level: cfg.level, redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } });
  }
  const file = path.join(dir, `sassdesk-${new Date().toISOString().slice(0, 10)}.log`);
  // sync: true —— CLI 生命周期短，同步写避免退出时日志丢失
  const destination = pino.destination({ dest: file, mkdir: true, sync: true });
  return pino({ level: cfg.level, redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, destination);
}

/** 无操作日志（测试用）。 */
export function nullLogger(): Logger {
  const noop = () => {};
  const base: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => base,
  };
  return base;
}
