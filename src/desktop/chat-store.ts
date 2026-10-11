import fs from "node:fs";
import path from "node:path";

/**
 * 聊天记录持久化：单会话滚动窗口，JSON 明文落盘（仅本机）。
 * - 文件：<dataDir>/chat.json
 * - 结构：{ version: 1, messages: ChatMessage[] }
 * - 上限 MAX_MESSAGES，超出丢最旧；损坏文件视为空会话（不抛）
 */

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  ts: number;
  /** assistant 消息是否被中断 */
  partial?: boolean;
}

export const MAX_MESSAGES = 200;

interface ChatFileShape {
  version: number;
  messages: ChatMessage[];
}

export class ChatStore {
  private readonly file: string;
  private messages: ChatMessage[] = [];
  private seq = 0;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "chat.json");
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Partial<ChatFileShape>;
      if (!Array.isArray(raw.messages)) return;
      this.messages = raw.messages.filter(
        (m): m is ChatMessage =>
          !!m && typeof m.id === "string" && typeof m.text === "string" && typeof m.ts === "number",
      );
      this.seq = this.messages.length;
    } catch {
      // 损坏文件：视为空会话，不阻塞启动
      this.messages = [];
    }
  }

  private save(): void {
    const data: ChatFileShape = { version: 1, messages: this.messages };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(data, null, 1), "utf-8");
    } catch {
      // 落盘失败不影响使用
    }
  }

  list(): ChatMessage[] {
    return this.messages.slice();
  }

  append(role: ChatMessage["role"], text: string, opts: { partial?: boolean } = {}): ChatMessage {
    const msg: ChatMessage = {
      id: `m${Date.now().toString(36)}-${(this.seq++).toString(36)}`,
      role,
      text,
      ts: Date.now(),
      ...(opts.partial !== undefined ? { partial: opts.partial } : {}),
    };
    this.messages.push(msg);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages = this.messages.slice(this.messages.length - MAX_MESSAGES);
    }
    this.save();
    return msg;
  }

  /** 更新最后一条消息（流式完成后定稿）。 */
  updateLast(id: string, patch: { text?: string; partial?: boolean }): ChatMessage | null {
    const target = this.messages.find((m) => m.id === id);
    if (!target) return null;
    if (patch.text !== undefined) target.text = patch.text;
    if (patch.partial !== undefined) target.partial = patch.partial;
    this.save();
    return target;
  }

  clear(): void {
    this.messages = [];
    this.save();
  }
}
