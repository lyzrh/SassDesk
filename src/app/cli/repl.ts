import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { createEventBridge } from "../../agent/core/events.js";
import type { ApprovalHandler, ApprovalRequest } from "../../agent/core/approval.js";
import { PetController } from "../../desktop/pet-controller.js";
import { SassDeskError } from "../../shared/errors.js";
import type { AppContext } from "../bootstrap.js";
import { transcribeWithWhisper } from "../voice/providers/whisper.js";
import { VoiceError } from "../voice/types.js";
import { isPetRunning, pushPetState, readPetInfo, startPet } from "./petBridge.js";

/** 状态中文标签（CLI 状态提示用）。 */
const STATE_LABELS: Record<string, string> = {
  idle: "待机",
  listening: "聆听中…",
  thinking: "思考中…",
  working: "工作中…",
  success: "任务完成！",
  error: "出错了",
  sleeping: "休息中（zzz）",
};

/**
 * SassDesk CLI（v0.1.0）：
 * - 中文多轮文本 REPL（readline，零额外依赖）
 * - 斜杠命令：/help /rules /startup /voice /voice-file /prefs /quit
 * - 交互式授权确认（confirm / startup-auth 工具的 y/n 闸门）
 * - Ctrl+C：任务运行中取消任务，空闲时退出
 */

/** 交互式授权确认器。 */
class InteractiveApprovalHandler implements ApprovalHandler {
  constructor(private readonly rl: readline.Interface) {}

  async requestApproval(req: ApprovalRequest): Promise<boolean> {
    const answer = await ask(this.rl, `\n⚠ 需要你的确认 ──────────────────────\n${req.summary}\n允许执行吗？(y=同意 / 其他=拒绝) > `);
    const approved = answer.trim().toLowerCase() === "y";
    console.log(approved ? "✓ 已同意\n" : "✗ 已拒绝\n");
    return approved;
  }
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer));
  });
}

const HELP_TEXT = [
  "SassDesk v0.2.0 —— 你的桌面 AI 员工",
  "",
  "用法：直接输入中文任务（如「现在打开 QQ 音乐」「以后每次开机自动打开 QQ 音乐」）。",
  "",
  "命令：",
  "  /help              显示帮助",
  "  /rules             查看自动化规则",
  "  /startup           查看开机启动状态",
  "  /pet               查看 Sass 状态与桌宠连接状态",
  "  /pet start         启动桌面桌宠（Live2D 角色）",
  "  /api [on|off]      查看/切换是否接入模型 API（off=纯命令模式，不需要 Key）",
  "  /voice             按键录音并语音识别（需 voice.provider=sapi，音频不出本机）",
  "  /voice-file <路径>  用 Whisper 兼容服务转写音频文件（音频会上传到配置的服务）",
  "  /prefs             查看音乐偏好",
  "  /quit              退出（Ctrl+C 同效）",
].join("\n");

export async function startRepl(ctx: AppContext): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${ctx.config.character.name}> `,
  });

  const approval = new InteractiveApprovalHandler(rl);
  // API 接入开关（/api on|off 会话内即时生效并写入 config.local.json）
  let apiEnabled = ctx.config.llm.enabled;
  // 角色状态机：由真实用户交互与 Agent 生命周期事件驱动
  const pet = new PetController();
  pet.subscribe(({ to, reason }) => {
    // CLI 状态实时同步给桌宠窗口（桌宠未运行则静默）
    void pushPetState(ctx.configDir, to, reason);
    const tag = STATE_LABELS[to] ?? to;
    process.stdout.write(`\n[Sass] ${tag}${to === "error" && reason ? `（${reason.split("\n")[0]?.slice(0, 60)}）` : ""}\n`);
    rl.prompt(true);
  });
  console.log(HELP_TEXT);
  console.log(`\n数据目录：${ctx.dataDir}\n配置目录：${ctx.configDir}\n`);
  rl.prompt();

  let interrupted = false;
  rl.on("SIGINT", () => {
    if (currentAgent && currentAgent.isBusy) {
      console.log("\n(已请求取消当前任务…)");
      currentAgent.abort();
      return;
    }
    if (interrupted) {
      console.log("\n再见！");
      rl.close();
      process.exit(0);
    }
    interrupted = true;
    console.log("\n再按一次 Ctrl+C 退出。");
    setTimeout(() => (interrupted = false), 3000);
    rl.prompt();
  });

  let currentAgent: import("../../agent/core/sassdesk-agent.js").SassDeskAgent | null = null;

  rl.on("line", (line) => {
    void handleLine(line.trim()).catch((e) => {
      console.error(`出错了：${e instanceof Error ? e.message : String(e)}`);
      rl.prompt();
    });
  });

  async function handleLine(input: string): Promise<void> {
    if (input === "") {
      rl.prompt();
      return;
    }
    // 忙时保护：任务运行中的新行（包括管道模式授权行）不并发发给 Agent
    if (currentAgent && currentAgent.isBusy) {
      console.log("\n(正在处理上一个任务，请稍候；运行中可按 Ctrl+C 取消)");
      return;
    }
    if (input.startsWith("/")) {
      await handleCommand(input);
      rl.prompt();
      return;
    }

    // API 未接入：纯命令模式，不调用模型
    if (!apiEnabled) {
      console.log("当前未接入 API（纯命令模式）。可用：/help /rules /startup /pet /prefs /voice");
      console.log("开启模型能力：/api on");
      rl.prompt();
      return;
    }

    // 普通输入 → Agent（经 PetController 驱动角色状态：listening/thinking → working → success/error）
    const agent = await ctx.ensureAgent(approval);
    currentAgent = agent;
    agent.subscribe(
      createEventBridge({
        onTextDelta: (d) => process.stdout.write(d),
        onToolStart: ({ toolName }) => process.stdout.write(`\n⚙ 执行工具 ${toolName} …\n`),
        onToolEnd: ({ toolName, durationMs, isError }) =>
          process.stdout.write(`${isError ? "✗" : "✓"} ${toolName} 完成${durationMs !== undefined ? `（${durationMs}ms）` : ""}\n`),
      }),
    );
    try {
      const result = await pet.runWithAgent(agent, input);
      if (result.text !== "") {
        process.stdout.write("\n");
      }
      if (result.truncated) {
        console.log("（提示：本任务达到最大工具调用轮数上限，已停止。可拆成更小的任务或调大 llm.maxIterations。）");
      }
      if (result.errorMessage) {
        console.log(`（模型错误：${result.errorMessage}）`);
      }
      const used = result.toolCalls.length;
      ctx.logger.info({ iterations: result.iterations, toolCalls: used }, "任务完成");
    } catch (e) {
      if (e instanceof SassDeskError) console.log(`任务失败：${e.toUserMessage()}`);
      else console.log(`任务失败：${(e as Error).message}`);
    } finally {
      currentAgent = null;
      rl.prompt();
    }
  }

  async function handleCommand(input: string): Promise<void> {
    const [cmd, ...rest] = input.split(/\s+/);
    switch (cmd) {
      case "/help":
        console.log(HELP_TEXT);
        return;
      case "/rules": {
        const rules = ctx.rules.list();
        if (rules.length === 0) console.log("当前没有自动化规则。");
        else {
          for (const r of rules) {
            console.log(`• ${r.name} [${r.trigger === "startup" ? "开机" : "手动"}] ${r.enabled ? "已启用" : "已停用"}（${r.actions.map((a) => a.type + ":" + ("appId" in a ? a.appId : "")).join(", ")}）`);
          }
        }
        return;
      }
      case "/startup": {
        const status = await ctx.startup.getStatus("SassDeskStartup");
        console.log(status ? `开机启动：已注册 → ${status.command}` : "开机启动：未注册");
        return;
      }
      case "/prefs": {
        const p = ctx.prefs.load();
        console.log(`喜欢的歌曲：${p.favoriteSongs.map((s) => (s.artist ? `${s.title}(${s.artist})` : s.title)).join("、") || "（无）"}`);
        console.log(`喜欢的歌单：${p.favoritePlaylists.join("、") || "（无）"}`);
        return;
      }
      case "/pet": {
        if (rest[0] === "start") {
          console.log("正在启动桌宠…");
          const r = await startPet(ctx.configDir);
          console.log(r.message);
          return;
        }
        console.log(`[Sass] 当前状态：${STATE_LABELS[pet.state] ?? pet.state}`);
        const info = readPetInfo(ctx.configDir);
        if (await isPetRunning(ctx.configDir)) {
          console.log(`桌宠：运行中（端口 ${info?.port}）— CLI 状态会实时同步过去`);
        } else {
          console.log("桌宠：未运行（/pet start 启动；启动后 CLI 状态自动同步）");
        }
        return;
      }
      case "/api": {
        const sub = (rest[0] ?? "").toLowerCase();
        const cfgPath = path.join(ctx.configDir, "config.local.json");
        if (sub === "on" || sub === "off") {
          const enabled = sub === "on";
          let local: Record<string, unknown> = {};
          try {
            local = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
          } catch {
            /* 文件不存在则新建 */
          }
          local.llm = { ...((local.llm as object) ?? {}), enabled };
          fs.writeFileSync(cfgPath, JSON.stringify(local, null, 2));
          apiEnabled = enabled;
          console.log(enabled ? "已开启 API 接入（自然语言任务可用）" : "已关闭 API 接入：纯命令模式，斜杠命令照常可用，不需要 API Key");
          return;
        }
        console.log(`API 接入：${apiEnabled ? "已开启" : "已关闭（纯命令模式）"}`);
        console.log(`provider=${ctx.config.llm.provider} model=${ctx.config.llm.model} key=${ctx.config.llm.apiKey ? "已配置" : "未配置（走环境变量）"}`);
        console.log("用法：/api off 关闭 | /api on 开启");
        return;
      }
      case "/voice": {
        if (!ctx.voice) {
          console.log("当前 voice.provider 不是 mock/sapi，无法使用麦克风采集。用 /voice-file <路径> 走 Whisper 转写，或修改配置。");
          return;
        }
        console.log("按回车开始说话（再次按回车或静音后结束识别）…");
        await ask(rl, "准备好后按回车 > ");
        pet.inputStart(); // 录音开始 → LISTENING
        try {
          const result = await ctx.voice.capture({ maxSeconds: Math.round(ctx.config.voice.recordTimeoutMs / 1000) });
          console.log(`\n识别结果（${result.providerId}${result.mock ? "，模拟" : ""}）：${result.text}`);
          const confirm = await ask(rl, "把这句话发给 SassDesk 吗？(y=发送 / 其他=丢弃) > ");
          if (confirm.trim().toLowerCase() === "y") {
            pet.inputEnd(); // 录音结束 → THINKING（随后 runWithAgent 接管）
            await handleLine(result.text);
            return;
          }
          pet.wake(); // 丢弃 → 回待机
          console.log("已丢弃。");
        } catch (e) {
          pet.wake();
          if (e instanceof VoiceError) console.log(`语音识别失败：${e.message}`);
          else console.log(`语音识别失败：${(e as Error).message}`);
        }
        return;
      }
      case "/voice-file": {
        const file = rest[0];
        if (!file) {
          console.log("用法：/voice-file <wav或mp3文件路径>");
          return;
        }
        const abs = path.resolve(file);
        if (!fs.existsSync(abs)) {
          console.log(`文件不存在：${abs}`);
          return;
        }
        const apiKey = process.env["SASSDESK_STT_API_KEY"] ?? process.env["SASSDESK_API_KEY"] ?? process.env["OPENAI_API_KEY"] ?? "";
        console.log(`（注意：该模式会把音频上传到 ${ctx.config.voice.sttBaseUrl || "(未配置服务地址)"}）`);
        try {
          const result = await transcribeWithWhisper(
            { baseUrl: ctx.config.voice.sttBaseUrl, model: ctx.config.voice.sttModel, apiKey },
            abs,
          );
          console.log(`识别结果：${result.text}`);
          const confirm = await ask(rl, "把这句话发给 SassDesk 吗？(y=发送 / 其他=丢弃) > ");
          if (confirm.trim().toLowerCase() === "y") await handleLine(result.text);
        } catch (e) {
          if (e instanceof VoiceError) console.log(`语音识别失败：${e.message}`);
          else console.log(`语音识别失败：${(e as Error).message}`);
        }
        return;
      }
      case "/quit":
        console.log("再见！");
        pet.dispose();
        rl.close();
        process.exit(0);
        break; // eslint-disable-line no-unreachable
      default:
        console.log(`未知命令 ${cmd}。输入 /help 查看帮助。`);
        return;
    }
  }

  await new Promise<void>((resolve) => {
    rl.on("close", () => resolve());
  });
}
