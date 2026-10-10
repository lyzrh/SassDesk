import fs from "node:fs";
import path from "node:path";
import type { AutomationRule, RuleExecutionRecord } from "./types.js";
import type { AutomationRuleStore } from "./rules.js";
import type { QQMusicLauncher } from "../music/qqmusic.js";
import type { AppLauncher } from "../system/process/runner.js";
import type { PowerShellRunner } from "../system/windows/powershell.js";
import type { Logger } from "../../runtime/logging/logger.js";
import { toError } from "../../shared/errors.js";

/**
 * 规则执行器：
 * - 开机执行入口（SassDesk --run-startup）与手动执行共用；
 * - 每次执行写 JSONL 审计记录（data/executions.jsonl）；
 * - 对外程序的控制有明确成功判据（QQ 音乐：进程确认）。
 */

export interface RuleRunnerDeps {
  rules: AutomationRuleStore;
  qqmusic: QQMusicLauncher;
  launcher: AppLauncher;
  ps: PowerShellRunner;
  dataDir: string;
  logger: Logger;
}

export interface RuleRunReport {
  ruleId: string;
  ruleName: string;
  status: RuleExecutionRecord["status"];
  detail: string;
  steps: Array<{ action: string; ok: boolean; detail: string }>;
}

export class RuleRunner {
  constructor(private readonly deps: RuleRunnerDeps) {}

  /** 执行所有已启用且 trigger=startup 的规则（开机路径）。 */
  async runStartupRules(): Promise<RuleRunReport[]> {
    const enabled = this.deps.rules.list().filter((r) => r.enabled && r.trigger === "startup");
    const reports: RuleRunReport[] = [];
    for (const rule of enabled) {
      reports.push(await this.execute(rule));
    }
    return reports;
  }

  /** 执行单个规则（手动路径，接受任意 trigger）。 */
  async execute(rule: AutomationRule): Promise<RuleRunReport> {
    const steps: RuleRunReport["steps"] = [];
    let failed = 0;
    for (const action of rule.actions) {
      try {
        if (action.type === "start-app") {
          if (action.appId === "qqmusic") {
            const result = await this.deps.qqmusic.start();
            const ok = result.clientRunning;
            steps.push({ action: `start-app:qqmusic`, ok, detail: result.message });
            if (!ok) failed += 1;
          } else {
            // 其他白名单应用：解析路径 → 启动（无进程验证，结果如实标注 dispatched）
            const { resolveAppPath, lookupInstalledAppExe, APP_WHITELIST } = await import("../system/windows/apps.js");
            const resolved = await resolveAppPath(action.appId, {
              registryLookup: async (kw) => lookupInstalledAppExe(kw, APP_WHITELIST[action.appId]?.exe ?? "app.exe", this.deps.ps),
            });
            if (!resolved) {
              steps.push({ action: `start-app:${action.appId}`, ok: false, detail: `应用 ${action.appId} 不在白名单或未找到安装路径` });
              failed += 1;
            } else {
              const dispatched = await this.deps.launcher.start(resolved.exePath, action.args ?? []);
              steps.push({ action: `start-app:${action.appId}`, ok: dispatched.dispatched, detail: dispatched.detail });
              if (!dispatched.dispatched) failed += 1;
            }
          }
        } else {
          steps.push({ action: String((action as { type?: string }).type), ok: false, detail: "不支持的动作类型" });
          failed += 1;
        }
      } catch (e) {
        failed += 1;
        steps.push({ action: String((action as { type?: string }).type), ok: false, detail: `执行异常：${toError(e).message}` });
      }
    }

    const status: RuleExecutionRecord["status"] = failed === 0 ? "success" : failed === steps.length ? "failed" : "partial";
    const detail = steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.action}: ${s.detail}`).join("\n");
    const report: RuleRunReport = { ruleId: rule.id, ruleName: rule.name, status, detail, steps };
    try {
      this.deps.rules.recordExecution(rule.id, { status, detail });
    } catch (e) {
      this.deps.logger.warn({ err: String(e) }, "记录规则执行状态失败");
    }
    this.appendAudit(rule, report);
    return report;
  }

  /** JSONL 审计日志（不含个人敏感数据，仅规则执行事实）。 */
  private appendAudit(rule: AutomationRule, report: RuleRunReport): void {
    try {
      const file = path.join(this.deps.dataDir, "executions.jsonl");
      fs.mkdirSync(this.deps.dataDir, { recursive: true });
      fs.appendFileSync(
        file,
        JSON.stringify({
          at: new Date().toISOString(),
          ruleId: rule.id,
          ruleName: rule.name,
          trigger: rule.trigger,
          status: report.status,
          steps: report.steps.map((s) => ({ action: s.action, ok: s.ok })),
        }) + "\n",
        "utf-8",
      );
    } catch (e) {
      this.deps.logger.warn({ err: String(e) }, "写入执行审计失败");
    }
  }
}
