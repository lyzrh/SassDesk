import { describe, it, expect, beforeEach } from "vitest";
import { JsonStore } from "../../src/app/storage/json-store.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sassdesk-store-"));
});

describe("storage/JsonStore", () => {
  it("write/read 原子往返", () => {
    const store = new JsonStore(dir, "kv");
    store.write("rules", [{ id: "r1", name: "测试规则" }]);
    expect(store.read("rules")).toEqual([{ id: "r1", name: "测试规则" }]);
    expect(store.keys()).toContain("rules");
  });

  it("read 不存在的键返回 undefined", () => {
    const store = new JsonStore(dir, "kv");
    expect(store.read("nothing")).toBeUndefined();
  });

  it("delete 删除后返回 true，再删返回 false", () => {
    const store = new JsonStore(dir, "kv");
    store.write("a", { x: 1 });
    expect(store.delete("a")).toBe(true);
    expect(store.delete("a")).toBe(false);
  });

  it("数据文件损坏时返回 undefined 并备份损坏文件", () => {
    const store = new JsonStore(dir, "kv");
    store.write("data", { ok: true });
    const file = path.join(dir, "kv", "data.json");
    fs.writeFileSync(file, "{corrupted!!!");
    expect(store.read("data")).toBeUndefined();
    const backups = fs.readdirSync(path.join(dir, "kv")).filter((f) => f.includes("corrupt"));
    expect(backups.length).toBe(1);
  });

  it("非法键名抛错（防路径穿越）", () => {
    const store = new JsonStore(dir, "kv");
    expect(() => store.read("../escape")).toThrowError(/非法存储键名/);
  });
});
