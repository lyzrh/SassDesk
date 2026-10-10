import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import fs from "node:fs";
import path from "node:path";
import type { SassDeskTool } from "../../agent/tools/types.js";
import type { AutomationRuleStore } from "../automation/rules.js";
import type { RuleRunner } from "../automation/runner.js";
import type { StartupProvider } from "../system/startup/registry.js";
import type { AutomationRule } from "../automation/types.js";
import { projectRoot } from "../../shared/paths.js";

/**
 * 自动化规则与开机启动工具组。
 * 权限级别：
 * - rule_list / startup_status / rule_disable：safe
 * - rule_save / rule_run：confirm（创建与手动执行需确认）
 * - rule_enable：startup-auth（启用自动化 + 修改开机启动，最高敏感级）
 */

export const STARTUP_ENTRY_NAME = "SassDeskStartup";

export interface AutomationToolsDeps {
  rules: AutomationRuleStore;
  runner: RuleRunner;
  startup: StartupProvider;
}

/** 构造开机启动命令（node dist/index.js --run-startup）。 */
export function buildStartupCommand(root: string = projectRoot()): string {
  const entry = path.join(root, "dist", "index.js");
  if (!fs.existsSync(entry)) {
    throw new Error(`未找到 ${entry}。请先运行 npm run build 构建项目，再启用开机自动化。`);
  }
  return `"${process.execPath}" "${entry}" --run-startup`;
}

function ruleToText(rule: AutomationRule): string {
  const actions = rule.actions.map((a) => (a.type === "start-app" ? `启动应用 ${a.appId}` : a.type)).join("；");
  const lines = [
    `规则「${rule.name}」（id: ${rule.id}）`,
    `  触发：${rule.trigger === "startup" ? "开机时" : "手动"}`,
    `  动作：${actions}`,
    `  状态：${rule.enabled ? "已启用" : "已停用（未启用前不会自动执行）"}`,
    `  授权：${rule.authorizedAt ?? "未授权"}`,
  ];
  if (rule.lastRun) lines.push(`  最近执行：${rule.lastRun.at} → ${rule.lastRun.status}`);
  return lines.join("\n");
}

export function createAutomationTools(deps: AutomationToolsDeps): SassDeskTool<any>[] {
  const EmptyParams = Type.Object({});
  const ruleListTool: SassDeskTool<typeof EmptyParams> = {
    name: "rule_list",
    label: "列出自动化规则",
    description: "列出所有已保存的自动化规则及其启用状态。无参数。",
    parameters: EmptyParams,
    dangerLevel: "safe",
    timeoutMs: 5_000,
    async execute() {
      const rules = deps.rules.list();
      const text = rules.length === 0 ? "当前没有已保存的自动化规则。" : rules.map(ruleToText).join("\n");
      return { content: [{ type: "text", text }], details: { count: rules.length, rules } };
    },
  };

  const SaveParams = Type.Object({
    name: Type.String({ description: "规则名称（唯一，如：开机播放 QQ 音乐）" }),
    trigger: Type.Union([Type.Literal("startup"), Type.Literal("manual")], { description: "触发方式" }),
    actions: Type.Array(
      Type.Object({
        type: Type.Literal("start-app"),
        appId: StringEnum(["qqmusic", "notepad", "mspaint", "calc"], { description: "白名单应用 ID" }),
      }),
      { description: "动作列表（v0.1.0 仅支持启动白名单应用）", minItems: 1 },
    ),
  });
  const ruleSaveTool: SassDeskTool<typeof SaveParams> = {
    name: "rule_save",
    label: "保存自动化规则",
    description:
      "把一条自动化规则保存为草稿（enabled=false，不会自动执行）。" +
      "trigger=startup 表示每次开机登录后执行；trigger=manual 表示仅手动执行。" +
      "保存后必须调用 rule_enable 并获得用户确认才会启用。",
    parameters: SaveParams,
    dangerLevel: "confirm",
    timeoutMs: 5_000,
    async execute(_id, params) {
      const rule = deps.rules.saveDraft({
        name: params.name,
        trigger: params.trigger,
        actions: params.actions.map((a) => ({ type: "start-app" as const, appId: a.appId })),
      });
      const text =
        `规则已保存（草稿，未启用）：\n${ruleToText(rule)}\n` +
        "注意：规则尚未启用，不会自动执行。要启用开机自动执行，需用户明确确认后调用 rule_enable。";
      return { content: [{ type: "text", text }], details: rule };
    },
  };

  const NameParams = Type.Object({
    name: Type.String({ description: "规则名称" }),
  });
  const ruleEnableTool: SassDeskTool<typeof NameParams> = {
    name: "rule_enable",
    label: "启用自动化规则",
    description:
      "启用一条规则。对 trigger=startup 的规则，这会注册 Windows 开机启动项（HKCU Run），" +
      "需要用户在确认对话中明确同意。参数 name 为规则名称。",
    parameters: NameParams,
    dangerLevel: "startup-auth",
    timeoutMs: 15_000,
    async execute(_id, params) {
      const rule = deps.rules.findByName(params.name);
      if (!rule) {
        throw new Error(`规则「${params.name}」不存在。可先调用 rule_list 查看。`);
      }
      if (rule.enabled) {
        // 幂等修复：已启用但开机启动项未注册（如上次注册失败/被外部删除）→ 补注册
        if (rule.trigger === "startup") {
          const existing = await deps.startup.getStatus(STARTUP_ENTRY_NAME);
          if (!existing) {
            const command = buildStartupCommand();
            await deps.startup.register(STARTUP_ENTRY_NAME, command);
            return {
              content: [
                {
                  type: "text",
                  text: `规则「${rule.name}」已是启用状态；检测到开机启动项缺失，已补注册（${command}）。`,
                },
              ],
              details: { ...rule, startupRepaired: true },
            };
          }
        }
        return {
          content: [{ type: "text", text: `规则「${rule.name}」已经是启用状态，开机启动项也正常。` }],
          details: rule,
        };
      }
      const authorizedAt = new Date().toISOString();
      const updated = deps.rules.enable(rule.id, { authorized: true, authorizedAt });
      let startupNote = "";
      if (updated.trigger === "startup") {
        const command = buildStartupCommand();
        const status = await deps.startup.register(STARTUP_ENTRY_NAME, command);
        startupNote = `已注册 Windows 开机启动项「${status.name}」→ ${status.command}。用户可随时通过 rule_disable 或系统任务管理器撤销。`;
      }
      const text = `规则「${updated.name}」已启用（用户已确认授权）。\n${startupNote}`;
      return { content: [{ type: "text", text }], details: { ...updated, startupRegistered: updated.trigger === "startup" } };
    },
  };

  const ruleDisableTool: SassDeskTool<typeof NameParams> = {
    name: "rule_disable",
    label: "停用自动化规则",
    description: "停用一条规则；若是开机规则，同时撤销开机启动项注册。参数 name 为规则名称。",
    parameters: NameParams,
    dangerLevel: "safe",
    timeoutMs: 15_000,
    async execute(_id, params) {
      const rule = deps.rules.findByName(params.name);
      if (!rule) {
        throw new Error(`规则「${params.name}」不存在。可先调用 rule_list 查看。`);
      }
      const updated = deps.rules.disable(rule.id);
      let note = "";
      if (updated.trigger === "startup") {
        const existed = await deps.startup.unregister(STARTUP_ENTRY_NAME);
        note = existed ? "已撤销开机启动项注册。" : "开机启动项本来未注册。";
      }
      return {
        content: [{ type: "text", text: `规则「${updated.name}」已停用。${note}` }],
        details: updated,
      };
    },
  };

  const ruleRunTool: SassDeskTool<typeof NameParams> = {
    name: "rule_run",
    label: "手动执行规则",
    description: "立即执行一次指定规则（无论其启用状态）。参数 name 为规则名称。",
    parameters: NameParams,
    dangerLevel: "confirm",
    timeoutMs: 45_000,
    async execute(_id, params) {
      const rule = deps.rules.findByName(params.name);
      if (!rule) {
        throw new Error(`规则「${params.name}」不存在。可先调用 rule_list 查看。`);
      }
      const report = await deps.runner.execute(rule);
      return {
        content: [{ type: "text", text: `规则「${report.ruleName}」执行结果：${report.status}\n${report.detail}` }],
        details: report,
      };
    },
  };

  const StartupStatusParams = Type.Object({});
  const startupStatusTool: SassDeskTool<typeof StartupStatusParams> = {
    name: "startup_status",
    label: "查询开机启动状态",
    description: "查询 SassDesk 开机启动项（HKCU Run）当前注册状态。无参数。",
    parameters: StartupStatusParams,
    dangerLevel: "safe",
    timeoutMs: 10_000,
    async execute() {
      const status = await deps.startup.getStatus(STARTUP_ENTRY_NAME);
      const text = status
        ? `开机启动项「${status.name}」已注册：${status.command}`
        : "SassDesk 未注册开机启动（没有任何开机自动执行的规则在生效）。";
      return { content: [{ type: "text", text }], details: status ?? { registered: false } };
    },
  };

  return [ruleListTool, ruleSaveTool, ruleEnableTool, ruleDisableTool, ruleRunTool, startupStatusTool];
}
