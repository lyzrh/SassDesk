import type { KvStore } from "../storage/json-store.js";
import type { AutomationAction, AutomationRule, RuleTrigger } from "./types.js";
import { validateRule } from "./types.js";
import { SassDeskError } from "../../shared/errors.js";

/**
 * 自动化规则存取（基于 KvStore，单一 "rules" 集合）。
 * 状态机约束在此层强制：
 * - 保存时 enabled 恒为 false（防止模型直接启用）；
 * - enable(rule, { authorized }) 才允许置 true，且 startup 规则必须带授权；
 * - disable 同时保留授权记录（撤销启动项注册由调用方负责）。
 */

const STORE_KEY = "rules";

export class AutomationRuleStore {
  constructor(private readonly store: KvStore, private readonly clock: () => Date = () => new Date()) {}

  private readAll(): AutomationRule[] {
    const raw = this.store.read(STORE_KEY);
    return Array.isArray(raw) ? (raw as AutomationRule[]) : [];
  }

  private writeAll(rules: AutomationRule[]): void {
    this.store.write(STORE_KEY, rules);
  }

  list(): AutomationRule[] {
    return this.readAll();
  }

  get(id: string): AutomationRule | undefined {
    return this.readAll().find((r) => r.id === id);
  }

  findByName(name: string): AutomationRule | undefined {
    const target = name.trim();
    return this.readAll().find((r) => r.name === target);
  }

  /**
   * 保存新规则（enabled 强制 false）。
   * 同名规则已存在时抛错（让模型改名或删除旧规则）。
   */
  saveDraft(input: { name: string; trigger: RuleTrigger; actions: AutomationAction[] }): AutomationRule {
    const errors = validateRule({ name: input.name, trigger: input.trigger, actions: input.actions, enabled: false });
    if (errors.length > 0) {
      throw new SassDeskError("STORAGE_ERROR", `规则校验失败：${errors.join("；")}`, { input });
    }
    const all = this.readAll();
    if (all.some((r) => r.name === input.name.trim())) {
      throw new SassDeskError("STORAGE_ERROR", `已存在同名规则「${input.name}」。如需替换，请先删除旧规则。`);
    }
    const now = this.clock().toISOString();
    const rule: AutomationRule = {
      id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: input.name.trim(),
      trigger: input.trigger,
      actions: input.actions,
      enabled: false,
      createdAt: now,
      updatedAt: now,
    };
    all.push(rule);
    this.writeAll(all);
    return rule;
  }

  /** 启用规则。startup 触发必须携带用户授权（authorizedAt）；返回更新后的规则。 */
  enable(id: string, opts: { authorized: boolean; authorizedAt?: string }): AutomationRule {
    const all = this.readAll();
    const rule = all.find((r) => r.id === id);
    if (!rule) throw new SassDeskError("STORAGE_ERROR", `规则不存在：${id}`);
    if (!opts.authorized) {
      throw new SassDeskError("STORAGE_ERROR", `规则「${rule.name}」未经用户明确授权，拒绝启用。`);
    }
    if (rule.trigger === "startup" && !opts.authorizedAt) {
      throw new SassDeskError("STORAGE_ERROR", `开机规则「${rule.name}」启用时必须记录授权时间。`);
    }
    rule.enabled = true;
    if (opts.authorizedAt) rule.authorizedAt = opts.authorizedAt;
    rule.updatedAt = this.clock().toISOString();
    this.writeAll(all);
    return rule;
  }

  /** 停用规则（保留授权记录以便再次启用时不再询问？——v0.1.0 重新启用仍需确认）。 */
  disable(id: string): AutomationRule {
    const all = this.readAll();
    const rule = all.find((r) => r.id === id);
    if (!rule) throw new SassDeskError("STORAGE_ERROR", `规则不存在：${id}`);
    rule.enabled = false;
    rule.updatedAt = this.clock().toISOString();
    this.writeAll(all);
    return rule;
  }

  /** 更新最近一次执行状态。 */
  recordExecution(id: string, record: { status: "success" | "failed" | "partial"; detail: string }): AutomationRule {
    const all = this.readAll();
    const rule = all.find((r) => r.id === id);
    if (!rule) throw new SassDeskError("STORAGE_ERROR", `规则不存在：${id}`);
    rule.lastRun = { at: this.clock().toISOString(), ...record };
    rule.updatedAt = this.clock().toISOString();
    this.writeAll(all);
    return rule;
  }

  /** 删除规则。 */
  remove(id: string): boolean {
    const all = this.readAll();
    const next = all.filter((r) => r.id !== id);
    if (next.length === all.length) return false;
    this.writeAll(next);
    return true;
  }
}
