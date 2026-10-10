#!/usr/bin/env node
import { bootstrapApp, fatal } from "./app/bootstrap.js";
import { startRepl } from "./app/cli/repl.js";
import { isSassDeskError } from "./shared/errors.js";

/**
 * SassDesk 入口。
 * - 默认：交互式 CLI
 * - --run-startup：开机执行模式（运行所有已启用的开机规则后退出）
 */

const args = process.argv.slice(2);

if (args.includes("--run-startup")) {
  await runStartupMode();
} else {
  await interactiveMode();
}

async function interactiveMode(): Promise<void> {
  console.log("SassDesk v0.1.0 启动中…");
  const ctx = bootstrapApp();
  try {
    await startRepl(ctx);
  } catch (e) {
    if (isSassDeskError(e)) fatal(e);
    fatal(e);
  }
}

async function runStartupMode(): Promise<void> {
  const ctx = bootstrapApp();
  const rules = ctx.rules.list().filter((r) => r.enabled && r.trigger === "startup");
  if (rules.length === 0) {
    console.log("[SassDesk] 没有已启用的开机规则，退出。");
    process.exit(0);
  }
  console.log(`[SassDesk] 开机执行模式：${rules.length} 条规则待执行。`);
  const reports = await ctx.runner.runStartupRules();
  for (const r of reports) {
    console.log(`\n■ 规则「${r.ruleName}」→ ${r.status}`);
    console.log(r.detail);
  }
  console.log("\n[SassDesk] 开机执行完成。");
  // 留出日志落盘时间后退出
  setTimeout(() => process.exit(0), 500);
}
