import { describe, it, expect, beforeEach } from "vitest";
import { JsonStore } from "../../src/app/storage/json-store.js";
import { AutomationRuleStore } from "../../src/app/automation/rules.js";
import { RuleRunner } from "../../src/app/automation/runner.js";
import { QQMusicLauncher } from "../../src/app/music/qqmusic.js";
import { InMemoryStartupProvider } from "../../src/app/system/startup/registry.js";
import { nullLogger } from "../../src/runtime/logging/logger.js";
import { createAutomationTools, buildStartupCommand, STARTUP_ENTRY_NAME } from "../../src/app/tools/automation-tools.js";
import { ToolRegistry } from "../../src/agent/tools/registry.js";
import { projectRoot } from "../../src/shared/paths.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * 集成测试：规则状态机 → 开机启动注册（InMemory）→ 规则执行（fake QQ 音乐依赖）。
 * 全程不触碰真实注册表、真实进程。
 */

interface FakeProbe {
  findByName(name: string): Promise<Array<{ name: string; id: number }>>;
}

function makeFakeProbe(sequence: number[][]): FakeProbe {
  let call = 0;
  return {
    async findByName() {
      const pids = sequence[Math.min(call, sequence.length - 1)] ?? [];
      call += 1;
      return pids.map((id) => ({ name: "QQMusic", id }));
    },
  };
}

let tmpDir: string;
let fakeExe: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sassdesk-rule-int-"));
  fakeExe = path.join(tmpDir, "QQMusic.exe");
  fs.writeFileSync(fakeExe, "fake-exe");
});

describe("integration: 规则执行与开机启动", () => {
  it("规则启用 → 注册开机启动项（InMemory）→ runStartupRules 执行成功并写审计", async () => {
    const kv = new JsonStore(tmpDir, "kv");
    const rules = new AutomationRuleStore(kv);
    const startup = new InMemoryStartupProvider();
    const qqmusic = new QQMusicLauncher(
      makeFakeProbe([[], [4242]]) as never,
      { start: async () => ({ dispatched: true, detail: "fake dispatched" }) } as never,
      { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } as never,
      fakeExe,
      { waitMs: 300, pollIntervalMs: 50 },
    );
    const runner = new RuleRunner({ rules, qqmusic, launcher: { start: async () => ({ dispatched: true, detail: "x" }) } as never, ps: { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } as never, dataDir: tmpDir, logger: nullLogger() });

    // 1. 保存草稿（confirm 工具在测试中直接调用内部实现）
    const rule = rules.saveDraft({ name: "开机播放 QQ 音乐", trigger: "startup", actions: [{ type: "start-app", appId: "qqmusic" }] });
    expect(rule.enabled).toBe(false);

    // 2. 启用（模拟用户已确认）→ startup provider 收到注册
    rules.enable(rule.id, { authorized: true, authorizedAt: new Date().toISOString() });
    const command = `"node.exe" "index.js" --run-startup`;
    await startup.register(STARTUP_ENTRY_NAME, command);
    expect((await startup.getStatus(STARTUP_ENTRY_NAME))?.command).toContain("--run-startup");

    // 3. 开机执行
    const reports = await runner.runStartupRules();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.status).toBe("success");
    expect(reports[0]!.steps[0]).toMatchObject({ ok: true });

    // 4. 审计 JSONL 已写
    const auditFile = path.join(tmpDir, "executions.jsonl");
    expect(fs.existsSync(auditFile)).toBe(true);
    const lines = fs.readFileSync(auditFile, "utf-8").trim().split("\n");
    expect(JSON.parse(lines[0]!)).toMatchObject({ ruleName: "开机播放 QQ 音乐", status: "success" });

    // 5. 规则状态已更新
    expect(rules.get(rule.id)?.lastRun?.status).toBe("success");

    // 6. 停用 → 撤销启动项
    rules.disable(rule.id);
    await startup.unregister(STARTUP_ENTRY_NAME);
    expect(await startup.getStatus(STARTUP_ENTRY_NAME)).toBeUndefined();
  });

  it("QQ 音乐启动失败时规则报告 partial/failed，不伪造成功", async () => {
    const kv = new JsonStore(tmpDir, "kv");
    const rules = new AutomationRuleStore(kv);
    const qqmusic = new QQMusicLauncher(
      makeFakeProbe([[], []]) as never, // 进程始终未出现
      { start: async () => ({ dispatched: true, detail: "fake dispatched" }) } as never,
      { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } as never,
      fakeExe,
      { waitMs: 200, pollIntervalMs: 50 },
    );
    const runner = new RuleRunner({ rules, qqmusic, launcher: { start: async () => ({ dispatched: true, detail: "x" }) } as never, ps: { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } as never, dataDir: tmpDir, logger: nullLogger() });

    const rule = rules.saveDraft({ name: "失败场景", trigger: "manual", actions: [{ type: "start-app", appId: "qqmusic" }] });
    const report = await runner.execute(rule);
    expect(report.status).toBe("failed");
    expect(report.steps[0]!.ok).toBe(false);
    expect(rules.get(rule.id)?.lastRun?.status).toBe("failed");
  });

  it("自动化工具注册表完整且权限级别正确", () => {
    const kv = new JsonStore(tmpDir, "kv");
    const rules = new AutomationRuleStore(kv);
    const startup = new InMemoryStartupProvider();
    const qqmusic = new QQMusicLauncher(makeFakeProbe([[]]) as never, { start: async () => ({ dispatched: true, detail: "x" }) } as never, { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } as never, fakeExe);
    const runner = new RuleRunner({ rules, qqmusic, launcher: { start: async () => ({ dispatched: true, detail: "x" }) } as never, ps: { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } as never, dataDir: tmpDir, logger: nullLogger() });

    const registry = new ToolRegistry(nullLogger());
    for (const t of createAutomationTools({ rules, runner, startup })) registry.register(t);

    const levels = Object.fromEntries(registry.list().map((t) => [t.name, t.dangerLevel]));
    expect(levels).toMatchObject({
      rule_list: "safe",
      rule_save: "confirm",
      rule_enable: "startup-auth",
      rule_disable: "safe",
      rule_run: "confirm",
      startup_status: "safe",
    });
  });

  it("buildStartupCommand 在 dist 缺失时报错（提示先构建），项目根构建后可用", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "sassdesk-nodist-"));
    expect(() => buildStartupCommand(emptyDir)).toThrowError(/npm run build/);
    // 真实项目根（本项目，构建后存在 dist/index.js）应成功构造
    const realCmd = buildStartupCommand(projectRoot());
    expect(realCmd).toContain("--run-startup");
    expect(realCmd).toContain("dist");
  });
});
