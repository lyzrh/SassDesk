/**
 * 自动化规则数据结构（v0.1.0）。
 * 生命周期：提出 → 用户确认 → 保存（enabled=false）→ 用户明确启用（含开机授权）→ 执行 → 记录结果。
 */

export type RuleTrigger = "startup" | "manual";

/** v0.1.0 动作：启动白名单应用。未来扩展：播放歌单、系统操作等。 */
export interface StartAppAction {
  type: "start-app";
  appId: string;
  args?: string[];
}

export type AutomationAction = StartAppAction;

export interface RuleExecutionRecord {
  at: string;
  status: "success" | "failed" | "partial";
  detail: string;
}

export interface AutomationRule {
  id: string;
  name: string;
  trigger: RuleTrigger;
  actions: AutomationAction[];
  /** 默认 false；只有用户明确确认后才可置 true。 */
  enabled: boolean;
  /** 用户明确授权的时间（startup 规则启用时必填）。 */
  authorizedAt?: string;
  lastRun?: RuleExecutionRecord;
  createdAt: string;
  updatedAt: string;
}

export function validateRule(rule: Omit<AutomationRule, "id" | "createdAt" | "updatedAt">): string[] {
  const errors: string[] = [];
  if (!rule.name || rule.name.trim() === "") errors.push("规则名称不能为空");
  if (rule.trigger !== "startup" && rule.trigger !== "manual") errors.push(`不支持的触发器：${String(rule.trigger)}`);
  if (!Array.isArray(rule.actions) || rule.actions.length === 0) errors.push("规则至少需要一个动作");
  for (const action of rule.actions) {
    if (action.type !== "start-app") errors.push(`不支持的动作类型：${String((action as { type?: string }).type)}`);
    else if (!action.appId || action.appId.trim() === "") errors.push("start-app 动作缺少 appId");
  }
  return errors;
}
