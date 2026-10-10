import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MutableModels } from "@earendil-works/pi-ai";
import { loadConfig, requireApiKey } from "../runtime/config/load.js";
import type { AppConfig } from "../runtime/config/schema.js";
import { createLogger, nullLogger } from "../runtime/logging/logger.js";
import type { Logger } from "../runtime/logging/logger.js";
import { createSassDeskModels } from "../runtime/llm/models.js";
import { ToolRegistry } from "../agent/tools/registry.js";
import { SassDeskAgent } from "../agent/core/sassdesk-agent.js";
import { buildSystemPrompt } from "../agent/core/system-prompt.js";
import type { ApprovalHandler } from "../agent/core/approval.js";
import { JsonStore } from "./storage/json-store.js";
import { ChildPowerShellRunner } from "./system/windows/powershell.js";
import type { PowerShellRunner } from "./system/windows/powershell.js";
import { PowerShellProcessProbe } from "./system/process/probe.js";
import { ChildAppLauncher } from "./system/process/runner.js";
import { HkcuRunStartupProvider } from "./system/startup/registry.js";
import type { StartupProvider } from "./system/startup/registry.js";
import { QQMusicLauncher } from "./music/qqmusic.js";
import { PreferencesStore } from "./preferences/store.js";
import { AutomationRuleStore } from "./automation/rules.js";
import { RuleRunner } from "./automation/runner.js";
import { defaultCharacter, characterPersona } from "./characters/types.js";
import { createEnvInfoTool } from "./tools/system-info.js";
import { createProcessQueryTool, createProcessStartTool } from "./tools/process-tools.js";
import { createQQMusicStatusTool, createQQMusicStartTool } from "./tools/music-tools.js";
import { createAutomationTools } from "./tools/automation-tools.js";
import { MockVoiceCapture } from "./voice/providers/mock.js";
import { SapiVoiceCapture } from "./voice/providers/sapi.js";
import type { VoiceCapture } from "./voice/types.js";
import { SassDeskError } from "../shared/errors.js";
import { resolveDataDir, resolveConfigDir } from "../shared/paths.js";

/**
 * bootstrap：组装三层（Runtime → Agent Core → Application）。
 * Agent 依赖真实模型配置，惰性创建——保证 --run-startup 在未配置 API Key 时也能执行规则。
 */

export interface AppContext {
  config: AppConfig;
  configDir: string;
  configPath: string;
  projectRoot: string;
  dataDir: string;
  logger: Logger;
  ps: PowerShellRunner;
  startup: StartupProvider;
  rules: AutomationRuleStore;
  runner: RuleRunner;
  prefs: PreferencesStore;
  qqmusic: QQMusicLauncher;
  voice: VoiceCapture | null;
  /** 惰性创建 Agent（需要 API Key）。重复调用返回同一实例。 */
  ensureAgent(approvalHandler?: ApprovalHandler): Promise<SassDeskAgent>;
}

export function bootstrapApp(opts: { env?: NodeJS.ProcessEnv; log?: boolean; dataDir?: string; ps?: PowerShellRunner; startup?: StartupProvider } = {}): AppContext {
  const env = opts.env ?? process.env;
  const log = opts.log ?? true;

  const { config, configDir, warnings } = loadConfig({ env });
  const configPath = path.join(configDir, "config.local.json");
  const root = resolveProjectRoot();
  const dataDir = opts.dataDir ?? resolveDataDir(env);

  const logger = log ? createLogger(config.logging, { projectRoot: root }) : nullLogger();
  for (const w of warnings) logger.warn({ warning: w }, "配置警告");

  const ps = opts.ps ?? new ChildPowerShellRunner();
  const startup = opts.startup ?? new HkcuRunStartupProvider(ps);

  const store = new JsonStore(dataDir, "kv");
  const prefs = new PreferencesStore(store);
  const rules = new AutomationRuleStore(store);
  const probe = new PowerShellProcessProbe(ps);
  const launcher = new ChildAppLauncher();
  const qqmusic = new QQMusicLauncher(probe, launcher, ps, config.music.qqmusicPath);
  const runner = new RuleRunner({ rules, qqmusic, launcher, ps, dataDir, logger });

  let voice: VoiceCapture | null;
  if (config.voice.provider === "mock") voice = new MockVoiceCapture();
  else if (config.voice.provider === "sapi") voice = new SapiVoiceCapture(ps);
  else voice = null; // whisper：文件转写模式，走独立入口

  let agentSingleton: SassDeskAgent | null = null;

  const ctx: AppContext = {
    config,
    configDir,
    configPath,
    projectRoot: root,
    dataDir,
    logger,
    ps,
    startup,
    rules,
    runner,
    prefs,
    qqmusic,
    voice,
    async ensureAgent(approvalHandler?: ApprovalHandler) {
      if (agentSingleton) return agentSingleton;
      // 前置 API Key 检查：给出明确的中文配置指引，而不是让模型调用在运行中途失败
      requireApiKey(config.llm, env);
      const { models } = createSassDeskModels(config.llm, env);
      const registry = new ToolRegistry(logger.child({ component: "tools" }));
      registry.register(createEnvInfoTool({ dataDir, configPath }));
      registry.register(createProcessQueryTool({ probe }));
      registry.register(createProcessStartTool({ launcher, ps, overrides: { qqmusic: config.music.qqmusicPath } }));
      registry.register(createQQMusicStatusTool({ qqmusic }));
      registry.register(createQQMusicStartTool({ qqmusic }));
      for (const t of createAutomationTools({ rules, runner, startup })) {
        registry.register(t);
      }
      const character = defaultCharacter(config.character.name);
      agentSingleton = new SassDeskAgent({
        systemPrompt: buildSystemPrompt({
          persona: characterPersona(character),
          preferencesSummary: prefs.summary(),
          now: new Date().toLocaleString("zh-CN", { hour12: false }),
        }),
        config: config.llm,
        models: models as MutableModels,
        registry,
        approvalHandler,
        logger,
      });
      return agentSingleton;
    },
  };

  return ctx;
}

function resolveProjectRoot(): string {
  // 编译后 dist/app/bootstrap.js → 上两级；源码 src/app → 上两级（仓库根）
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** 统一处理启动失败：中文提示 + 退出码。 */
export function fatal(e: unknown): never {
  if (e instanceof SassDeskError) {
    console.error(`\n[SassDesk] 启动失败：${e.toUserMessage()}`);
  } else {
    console.error(`\n[SassDesk] 启动失败：${(e as Error)?.message ?? String(e)}`);
  }
  process.exit(1);
}
