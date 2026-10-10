import fs from "node:fs";
import path from "node:path";

/**
 * JSON 文件存储（接口化，后续可替换为 SQLite/云同步而不动上层）。
 * 写入采用「临时文件 + rename」原子写，避免进程中断损坏数据。
 */

export interface KvStore {
  read(key: string): unknown;
  write(key: string, value: unknown): void;
  delete(key: string): boolean;
  keys(): string[];
}

export class JsonStore implements KvStore {
  constructor(private readonly baseDir: string, private readonly namespace: string) {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private get dir(): string {
    return path.join(this.baseDir, this.namespace);
  }

  private fileFor(key: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      throw new Error(`非法存储键名：${key}`);
    }
    return path.join(this.dir, `${key}.json`);
  }

  read(key: string): unknown {
    const file = this.fileFor(key);
    try {
      const text = fs.readFileSync(file, "utf-8");
      return JSON.parse(text) as unknown;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      // 数据损坏：重命名备份并返回 undefined，让上层重建（明确记录，不静默）
      const backup = `${file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(file, backup);
      } catch {
        /* 忽略备份失败 */
      }
      console.warn(`[SassDesk] 警告：数据文件损坏已备份为 ${backup}（namespace=${this.namespace}, key=${key}）`);
      return undefined;
    }
  }

  write(key: string, value: unknown): void {
    const file = this.fileFor(key);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
    fs.renameSync(tmp, file);
  }

  delete(key: string): boolean {
    const file = this.fileFor(key);
    try {
      fs.unlinkSync(file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw err;
    }
  }

  keys(): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -".json".length));
    } catch {
      return [];
    }
  }
}
