import { describe, it, expect, beforeEach } from "vitest";
import { AutomationRuleStore } from "../../src/app/automation/rules.js";
import { JsonStore } from "../../src/app/storage/json-store.js";
import { InMemoryStartupProvider } from "../../src/app/system/startup/registry.js";
import { SassDeskError } from "../../src/shared/errors.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let dir: string;
let store: AutomationRuleStore;
let kv: JsonStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sassdesk-rules-"));
  kv = new JsonStore(dir, "kv");
  store = new AutomationRuleStore(kv);
});

describe("automation/rules 状态机", () => {
  it("saveDraft 保存草稿且 enabled 强制为 false", () => {
    const rule = store.saveDraft({
      name: "开机播放 QQ 音乐",
      trigger: "startup",
      actions: [{ type: "start-app", appId: "qqmusic" }],
    });
    expect(rule.enabled).toBe(false);
    expect(rule.authorizedAt).toBeUndefined();
    expect(store.list()).toHaveLength(1);
  });

  it("同名规则拒绝保存", () => {
    store.saveDraft({ name: "规则A", trigger: "manual", actions: [{ type: "start-app", appId: "notepad" }] });
    expect(() => store.saveDraft({ name: "规则A", trigger: "manual", actions: [{ type: "start-app", appId: "calc" }] })).toThrowError(SassDeskError);
  });

  it("非法动作类型被校验拒绝", () => {
    expect(() =>
      store.saveDraft({
        name: "坏规则",
        trigger: "startup",
        actions: [{ type: "delete-everything" } as never],
      }),
    ).toThrowError(/规则校验失败/);
  });

  it("enable 必须携带授权；startup 规则必须记录授权时间", () => {
    const rule = store.saveDraft({ name: "R", trigger: "startup", actions: [{ type: "start-app", appId: "qqmusic" }] });
    expect(() => store.enable(rule.id, { authorized: false })).toThrowError(/未经用户明确授权/);
    expect(() => store.enable(rule.id, { authorized: true })).toThrowError(/必须记录授权时间/);
    const enabled = store.enable(rule.id, { authorized: true, authorizedAt: new Date().toISOString() });
    expect(enabled.enabled).toBe(true);
    expect(enabled.authorizedAt).toBeTruthy();
  });

  it("disable 停用规则", () => {
    const rule = store.saveDraft({ name: "R2", trigger: "manual", actions: [{ type: "start-app", appId: "calc" }] });
    store.enable(rule.id, { authorized: true });
    const disabled = store.disable(rule.id);
    expect(disabled.enabled).toBe(false);
  });

  it("recordExecution 记录最近执行状态", () => {
    const rule = store.saveDraft({ name: "R3", trigger: "manual", actions: [{ type: "start-app", appId: "calc" }] });
    const updated = store.recordExecution(rule.id, { status: "success", detail: "一切正常" });
    expect(updated.lastRun?.status).toBe("success");
    expect(updated.lastRun?.detail).toBe("一切正常");
  });

  it("remove 删除规则", () => {
    const rule = store.saveDraft({ name: "R4", trigger: "manual", actions: [{ type: "start-app", appId: "calc" }] });
    expect(store.remove(rule.id)).toBe(true);
    expect(store.get(rule.id)).toBeUndefined();
    expect(store.remove(rule.id)).toBe(false);
  });
});

describe("startup/InMemoryStartupProvider", () => {
  it("注册-查询-撤销 幂等", async () => {
    const sp = new InMemoryStartupProvider();
    expect(await sp.getStatus("SassDeskStartup")).toBeUndefined();
    const reg = await sp.register("SassDeskStartup", "node index.js --run-startup");
    expect(reg.command).toBe("node index.js --run-startup");
    // 幂等：重复注册更新
    await sp.register("SassDeskStartup", "node index.js --run-startup --v2");
    expect((await sp.getStatus("SassDeskStartup"))?.command).toContain("--v2");
    expect(await sp.unregister("SassDeskStartup")).toBe(true);
    expect(await sp.unregister("SassDeskStartup")).toBe(false); // 不存在时静默成功
    expect(await sp.getStatus("SassDeskStartup")).toBeUndefined();
  });

  it("非法启动项名称拒绝", async () => {
    const sp = new InMemoryStartupProvider();
    await expect(sp.register("../bad name!", "cmd")).rejects.toThrowError(/非法启动项名称/);
  });
});
