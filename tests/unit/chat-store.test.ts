import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatStore, MAX_MESSAGES } from "../../src/desktop/chat-store.js";

describe("ChatStore 聊天记录持久化", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sassdesk-chat-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("追加消息并按时间顺序返回", () => {
    const store = new ChatStore(dir);
    store.append("user", "在吗");
    store.append("assistant", "在的");
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0]!.role).toBe("user");
    expect(list[1]!.text).toBe("在的");
    expect(list[0]!.id).not.toBe(list[1]!.id);
  });

  it("落盘后新实例可完整恢复（跨重启）", () => {
    const a = new ChatStore(dir);
    a.append("user", "记住我");
    a.append("assistant", "记住了");
    const b = new ChatStore(dir); // 模拟重启
    expect(b.list().map((m) => m.text)).toEqual(["记住我", "记住了"]);
  });

  it("流式消息：partial 预留 + updateLast 定稿", () => {
    const store = new ChatStore(dir);
    const msg = store.append("assistant", "", { partial: true });
    expect(msg.partial).toBe(true);
    store.updateLast(msg.id, { text: "流式完成的内容", partial: false });
    const found = new ChatStore(dir).list()[0]!;
    expect(found.text).toBe("流式完成的内容");
    expect(found.partial).toBe(false);
  });

  it("超过上限时丢弃最旧消息", () => {
    const store = new ChatStore(dir);
    for (let i = 0; i < MAX_MESSAGES + 5; i++) store.append("user", `msg-${i}`);
    const list = store.list();
    expect(list).toHaveLength(MAX_MESSAGES);
    expect(list[0]!.text).toBe("msg-5");
    expect(list[list.length - 1]!.text).toBe(`msg-${MAX_MESSAGES + 4}`);
  });

  it("clear 清空并持久化", () => {
    const store = new ChatStore(dir);
    store.append("user", "x");
    store.clear();
    expect(store.list()).toEqual([]);
    expect(new ChatStore(dir).list()).toEqual([]);
  });

  it("损坏文件视为空会话且不抛异常", () => {
    fs.writeFileSync(path.join(dir, "chat.json"), "{ 这不是合法 JSON", "utf-8");
    const store = new ChatStore(dir);
    expect(store.list()).toEqual([]);
    store.append("user", "继续用");
    expect(new ChatStore(dir).list()).toHaveLength(1);
  });

  it("非法条目被过滤（缺字段的消息丢弃）", () => {
    fs.writeFileSync(
      path.join(dir, "chat.json"),
      JSON.stringify({
        version: 1,
        messages: [
          { id: "a", role: "user", text: "好的", ts: 1 },
          { role: "user" },
          { id: "b", role: "user", ts: 2 },
        ],
      }),
      "utf-8",
    );
    const store = new ChatStore(dir);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.text).toBe("好的");
  });
});
