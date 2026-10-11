/**
 * 全功能实测脚本（真实 LLM + 真实系统副作用，需先配置 API Key 并 npm run build）。
 *
 * 用法：node scripts/live-test.mjs
 *
 * 覆盖：safe 工具（进程查询/环境信息）、confirm 授权流（启动记事本+进程验证）、
 * 自动化规则（创建→启用→模拟开机执行→停用→撤销）。
 * 注意：会真实启动记事本并在结束时关闭；会真实读写 HKCU Run（结束前撤销）。
 * QQ 音乐场景需本机安装 QQ 音乐（未安装时工具会如实报告路径缺失）。
 */
import { bootstrapApp } from "../dist/app/bootstrap.js";
import { PowerShellProcessProbe } from "../dist/app/system/process/probe.js";
import { ChildPowerShellRunner } from "../dist/app/system/windows/powershell.js";
import { execSync } from "node:child_process";

const ctx = bootstrapApp({ log: false });
const probe = new PowerShellProcessProbe(new ChildPowerShellRunner());
const agent = await ctx.ensureAgent({
  // 实测脚本自动同意授权（真实使用时由 CLI 的 y/n 确认承担）
  requestApproval: async (req) => {
    console.log(`\n[授权门] ${req.toolLabel}（${req.toolName}）→ 自动同意`);
    console.log(req.summary.split("\n").map((l) => "  | " + l).join("\n"));
    return true;
  },
});

async function run(label, text) {
  console.log(`\n======== ${label} ========`);
  console.log(`用户> ${text}`);
  const r = await agent.run(text);
  console.log(`Sass> ${r.text || "(无文本回复)"}`);
  if (r.toolCalls.length) console.log(`[工具调用] ${r.toolCalls.map((t) => `${t.name}${t.isError ? "(错误)" : ""}`).join(" → ")}`);
  if (r.errorMessage) console.log(`[模型错误] ${r.errorMessage}`);
  return r;
}

// ===== 场景 1：safe 工具（真实 LLM 决策 + 真实 PowerShell）=====
await run("场景1-环境与进程", "帮我看看 explorer 进程在不在运行，顺便告诉我现在是什么系统");

// ===== 场景 2：confirm 授权 + 真实启动记事本 + 进程验证 =====
await run("场景2-启动记事本", "现在帮我打开记事本，然后用进程查询确认它真的开了");
const infos = await probe.findByName("notepad");
console.log(`[独立验证] notepad 进程：${infos.length} 个`);

// ===== 场景 3：自动化规则 → 启用 → 模拟开机执行 → 停用 =====
await run("场景3a-创建规则", "帮我创建一条自动化规则：每次开机后自动打开记事本，规则名叫「开机开记事本」");
await run("场景3b-启用规则", "我现在明确授权：直接启用「开机开记事本」这条规则，同意注册开机启动项");
const reg = await ctx.startup.getStatus("SassDeskStartup");
console.log(`[独立验证] HKCU Run：${reg ? "已注册 ✓" : "未注册（若在沙箱环境会明确报错）"}`);

console.log("\n======== 场景3c-模拟开机执行 ========");
console.log(execSync("node dist/index.js --run-startup", { encoding: "utf-8", timeout: 120_000 }).trim());

await run("场景3d-停用规则", "停用「开机开记事本」这条规则");
const reg2 = await ctx.startup.getStatus("SassDeskStartup");
console.log(`[独立验证] 停用后 HKCU Run：${reg2 ? "仍注册 ✗" : "已撤销 ✓"}`);

// ===== 场景 4：QQ 音乐（未安装时如实报告路径缺失）=====
await run("场景4-QQ音乐", "看看 QQ 音乐装没装、现在开没开；没装的话告诉我怎么配置");

// ===== 清理 =====
console.log("\n======== 清理 ========");
try {
  execSync("taskkill /IM notepad.exe /F", { encoding: "utf-8", stdio: "pipe" });
  console.log("[清理] 已关闭测试用记事本");
} catch {
  console.log("[清理] 记事本已不在运行");
}
console.log("[完成] 审计记录见 data/executions.jsonl");
process.exit(0);
