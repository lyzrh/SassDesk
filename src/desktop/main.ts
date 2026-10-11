/**
 * SassDesk 桌宠模式（Electron 主进程）。
 *
 * 职责：
 * - 透明无边框桌宠窗口（240×280，可拖动，不占任务栏）
 * - 托盘菜单：显示/隐藏、对话…、退出
 * - 对话输入窗（置顶小窗）→ 真实 Agent（复用 bootstrapApp + PetController）
 * - 状态机变化推送到渲染层；任务结果以气泡展示（textContent，防注入）
 *
 * 安全：不设置开机自启、不开麦克风、不截屏；contextIsolation 开启、nodeIntegration 关闭。
 */
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } from "electron";
import type { PetState } from "./state-machine.js";
import { bootstrapApp, type AppContext } from "../app/bootstrap.js";
import { createEventBridge } from "../agent/core/events.js";
import { PetController } from "./pet-controller.js";
import { ChatStore } from "./chat-store.js";
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url)); // dist/desktop
const rendererDir = path.join(here, "renderer");

/** 日志落盘（排障用）：logs/desktop-YYYY-MM-DD.log，渲染层 console 一并写入。 */
const desktopLogPath = path.join(path.resolve(here, "..", ".."), "logs", `desktop-${new Date().toISOString().slice(0, 10)}.log`);
function logLine(msg: string): void {
  console.log(msg);
  try {
    fs.mkdirSync(path.dirname(desktopLogPath), { recursive: true });
    fs.appendFileSync(desktopLogPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // 日志失败不影响运行
  }
}

// 透明窗口 + WebGL 合成兼容组合（社区验证）：
// - 保留 GPU 加速让 WebGL（Live2D）正常绘制
// - disable-gpu-compositing：窗口合成走软件路径，修复"DOM 可见但 canvas 空白"
// 可用 SASSDESK_SOFTWARE=1 强制全软件渲染（极端兼容模式）。
if (process.env.SASSDESK_SOFTWARE === "1") {
  app.disableHardwareAcceleration();
}
app.commandLine.appendSwitch("enable-transparent-visuals");
app.commandLine.appendSwitch("disable-gpu-compositing");

/**
 * 角色素材目录解析：
 * app.getAppPath() 在显式 .mjs 入口下返回入口目录（dist/desktop）而非项目根，
 * 会导致素材 404。因此显式探测多个候选位置，以 manifest.json 真实存在为准。
 */
function resolveCharAssetsDir(): string {
  const candidates = [
    path.resolve(here, "..", "..", "assets", "characters", "sass"), // <root>/assets（标准构建布局）
    path.resolve(here, "..", "assets", "characters", "sass"),        // dist/assets（复制布局）
    path.join(app.getAppPath(), "assets", "characters", "sass"),    // appPath 兜底
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "manifest.json"))) {
      logLine(`[SassDesk] 素材目录：${c}`);
      return c;
    }
  }
  console.warn(`[SassDesk] 未找到角色素材目录，尝试过：\n  ${candidates.join("\n  ")}`);
  return candidates[0]!;
}

const charAssetsDir = resolveCharAssetsDir();
// pathToFileURL 正确处理盘符/反斜杠/空格/中文等特殊字符，手工拼接 file:/// 在 Windows 下不可靠
const assetsDirUrl = pathToFileURL(charAssetsDir.endsWith(path.sep) ? charAssetsDir : charAssetsDir + path.sep).href;

interface PetManifest {
  fallback: string;
  states: Record<string, { src: string; poster?: string; animation: string; label: string }>;
}

let ctx: AppContext;
let manifest: PetManifest;
let pet: PetController;
let petWin: BrowserWindow | null = null;
let inputWin: BrowserWindow | null = null;
/** 控制面板（聊天 + CLI 入口）窗口 */
let panelWin: BrowserWindow | null = null;
/** 聊天记录持久化（<dataDir>/chat.json） */
let chatStore: ChatStore | null = null;
/** 正在流式输出的助手消息 id */
let streamingMsgId: string | null = null;
let tray: Tray | null = null;
let agent: Awaited<ReturnType<AppContext["ensureAgent"]>> | null = null;
/** 桌宠服务端口（固定端口供 CLI 发现；被占用自动回退随机）。 */
const PET_PORT = 22345;

/** Live2D 模型配置（探测到 assets/models 下的 model*.json 时启用）。 */
let live2dModelUrl: string | undefined;
/** 本地模型 HTTP 服务基址（渲染层库按相对路径加载 moc/贴图/motion 需 http URL）。 */
let modelServerBase = "";
let modelServer: http.Server | null = null;

/** 启动本地模型服务（仅伺服 assets/models，127.0.0.1 随机端口，端口零时自动分配）。 */
function startModelServer(): void {
  const modelsRoot = path.join(root(), "assets", "models");
  modelServer = http.createServer((req, res) => {
    // CLI 状态同步端点：POST /pet/state { state, reason? }
    if (req.method === "POST" && (req.url ?? "").startsWith("/pet/state")) {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf-8");
        if (body.length > 8192) req.destroy();
      });
      req.on("end", () => {
        try {
          const data = JSON.parse(body || "{}") as { state?: string; reason?: string };
          if (data.state) {
            pushState(data.state as PetState, data.reason);
            logLine(`[pet-bridge] 收到 CLI 状态：${data.state}${data.reason ? `（${data.reason.slice(0, 60)}）` : ""}`);
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end('{"ok":true}');
            return;
          }
        } catch {
          /* 落回 400 */
        }
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end('{"ok":false}');
      });
      return;
    }
    // 静态：模型文件
    const urlPath = decodeURIComponent(((req.url ?? "/").split("?")[0]) ?? "/");
    const filePath = path.normalize(path.join(modelsRoot, urlPath));
    if (!filePath.startsWith(modelsRoot)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const mime: Record<string, string> = {
        ".json": "application/json",
        ".png": "image/png",
        ".mtn": "text/plain; charset=utf-8",
        ".moc": "application/octet-stream",
      };
      res.setHeader("Content-Type", mime[ext] ?? "application/octet-stream");
      res.end(data);
    });
  });
  // 优先固定端口（CLI 侧按此发现桌宠）；被占用则回退随机端口
  const announce = () => {
    const addr = modelServer?.address() as AddressInfo;
    modelServerBase = `http://127.0.0.1:${addr.port}`;
    logLine(`[SassDesk] 模型服务已启动：${modelServerBase}（仅本地）`);
    // 写发现文件供 CLI 读取（连接/启动桌宠）
    try {
      fs.writeFileSync(
        path.join(ctx.configDir, "pet.json"),
        JSON.stringify({ port: addr.port, pid: process.pid, startedAt: new Date().toISOString() }, null, 1),
      );
    } catch (e) {
      logLine(`[SassDesk] 写 pet.json 失败：${(e as Error).message}`);
    }
  };
  modelServer.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logLine(`[SassDesk] 端口 ${PET_PORT} 被占用，改用随机端口`);
      modelServer?.listen(0, "127.0.0.1", announce);
    } else {
      logLine(`[SassDesk] 模型服务启动失败：${err.message}`);
    }
  });
  modelServer.listen(PET_PORT, "127.0.0.1", announce);
}

/** 探测 Live2D 模型（assets/models/<name>/model*.json，第一个命中者）。 */
function resolveLive2dModel(): string | undefined {
  const modelsRoot = path.join(root(), "assets", "models");
  try {
    for (const name of fs.readdirSync(modelsRoot)) {
      const dir = path.join(modelsRoot, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const entry = fs.readdirSync(dir).find((f) => f.endsWith(".model3.json") || f === "model.sassdesk.json" || f === "model.json");
      if (entry) {
        const url = pathToFileURL(path.join(dir, entry)).href;
        logLine(`[SassDesk] Live2D 模型：${url}`);
        return url;
      }
    }
  } catch {
    // 无模型目录：使用内置 SVG rig
  }
  return undefined;
}

/** 全局鼠标跟随轮询（30Hz）：Live2D 模型需要看向窗口外的鼠标。 */
function startCursorPolling(): void {
  const timer = setInterval(() => {
    if (!petWin || petWin.isDestroyed()) return;
    try {
      const p = screen.getCursorScreenPoint();
      const b = petWin.getBounds();
      const nx = clamp((p.x - b.x) / b.width, -1, 1) * 2 - 1; // -1..1，窗口中心为 0
      const ny = clamp((p.y - b.y) / b.height, -1, 1) * 2 - 1;
      petWin.webContents.send("pet:cursor", { x: nx, y: ny, inside: p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height });
    } catch {
      // 屏幕信息不可用时静默跳过
    }
  }, 33);
  app.on("before-quit", () => {
    clearInterval(timer);
    modelServer?.close();
    try { fs.rmSync(path.join(ctx.configDir, "pet.json"), { force: true }); } catch { /* 忽略 */ }
  });
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function root(): string {
  return path.resolve(here, "..", "..");
}

function loadManifest(): PetManifest {
  try {
    return JSON.parse(fs.readFileSync(path.join(charAssetsDir, "manifest.json"), "utf-8")) as PetManifest;
  } catch {
    // manifest 缺失/损坏：内置最小配置（渲染层还有图片级三级回退）
    return {
      fallback: "placeholder.svg",
      states: Object.fromEntries(
        ["idle", "listening", "thinking", "working", "success", "error", "sleeping"].map((s) => [
          s,
          { src: `${s}/${s}.png`, animation: "breathe", label: s },
        ]),
      ),
    };
  }
}

function pushState(state: string, reason?: string): void {
  petWin?.webContents.send("pet:state", { state, reason });
}

function pushBubble(text: string, accent = false): void {
  petWin?.webContents.send("pet:bubble", { text, accent });
}

/** 读取本进程写入的桌宠发现文件（面板查询用）。 */
function readPetInfoLocal(): { port: number; pid: number } | null {
  try {
    const p = path.join(ctx.configDir, "pet.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8")) as { port: number; pid: number };
  } catch {
    return null;
  }
}

/** 读取 Live2D 模型全量文件（渲染层经 IPC 获取，绕开 file:// fetch 限制）。 */
function readModelFiles(): {
  modelDirName: string;
  settings: unknown;
  moc: Uint8Array;
  textures: Uint8Array[];
  motions: Record<string, Uint8Array[]>;
  pose?: Uint8Array;
} | null {
  if (!live2dModelUrl) return null;
  try {
    const modelJsonPath = fileURLToPath(live2dModelUrl);
    const dir = path.dirname(modelJsonPath);
    // 优先用语义化适配版配置（idle/thinking/working/success/click）
    const adaptedPath = path.join(dir, "model.sassdesk.json");
    const settingsPath = fs.existsSync(adaptedPath) ? adaptedPath : modelJsonPath;
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
      model: string;
      textures: string[];
      physics?: string;
      pose?: string;
      motions?: Record<string, Array<{ file: string }>>;
    };
    const moc = fs.readFileSync(path.join(dir, settings.model));
    const textures = settings.textures.map((t) => fs.readFileSync(path.join(dir, t)));
    const motions: Record<string, Uint8Array[]> = {};
    for (const [group, list] of Object.entries(settings.motions ?? {})) {
      motions[group] = list.map((m) => fs.readFileSync(path.join(dir, m.file)));
    }
    const pose = settings.pose ? fs.readFileSync(path.join(dir, settings.pose)) : undefined;
    logLine(`[SassDesk] 模型文件读取：${Object.keys(motions).join("/")} 动作组，贴图 ${textures.length} 张${pose ? "，pose ✓" : ""}`);
    return { modelDirName: path.basename(dir), settings, moc, textures, motions, pose };
  } catch (e) {
    logLine(`[SassDesk] 模型文件读取失败：${(e as Error).message}`);
    return null;
  }
}

function createPetWindow(): void {
  if (petWin && !petWin.isDestroyed()) {
    petWin.show();
    return;
  }
  const { workArea } = screen.getPrimaryDisplay();
  const W = 240;
  const H = 280;
  petWin = new BrowserWindow({
    width: W,
    height: H,
    // 固定到工作区右下角（留边距），确保启动即可见
    x: Math.round(workArea.x + workArea.width - W - 24),
    y: Math.round(workArea.y + workArea.height - H - 24),
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    webPreferences: {
      preload: path.join(here, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  petWin.setMenuBarVisibility(false);
  // 诊断：转发渲染层 console 与页面加载失败（图片 404 / CSP 拦截 / preload 异常都会在这里现形）
  petWin.webContents.on("console-message", (_e, _level, message, line, sourceId) => {
    logLine(`[renderer] ${message} (${path.basename(sourceId)}:${line})`);
  });
  petWin.webContents.on("did-fail-load", (_e, code, desc, url) => {
    logLine(`[did-fail-load] ${code} ${desc} ${url}`);
  });
  void petWin.loadFile(path.join(rendererDir, "index.html"));
  petWin.webContents.on("did-finish-load", () => {
    petWin?.webContents.send("pet:config", {
      manifest,
      assetsDirUrl,
      live2dModelUrl: live2dModelUrl && modelServerBase ? modelServerBase + "/" + path.basename(path.dirname(fileURLToPath(live2dModelUrl))) + "/" + path.basename(fileURLToPath(live2dModelUrl)) : live2dModelUrl,
      render: {
        pma: process.env.SASSDESK_PMA !== "1",
        scale: Number(process.env.SASSDESK_SCALE ?? 2),
        noMotion: process.env.SASSDESK_NO_MOTION === "1",
      },
    });
    pushState(pet.state);
    // 开发调试：SASSDESK_SHOT=<png路径> 时，等待渲染稳定后截取窗口画面并退出（用于验证视觉呈现）
    const shotPath = process.env.SASSDESK_SHOT;
    if (shotPath) {
      setTimeout(() => {
        void (async () => {
          try {
            const img = await petWin?.webContents.capturePage();
            if (img) {
              fs.writeFileSync(shotPath, img.toPNG());
              logLine(`[shot] 窗口截图已保存：${shotPath}`);
            }
            // Live2D canvas 原始渲染导出（高清模型特写，检验脸部/部件质量）
            try {
              const dataUrl = (await petWin?.webContents.executeJavaScript(
                'window.__live2dCanvasShot ? window.__live2dCanvasShot() : null',
                false,
              )) as string | null;
              if (dataUrl) {
                const modelPath = shotPath.replace(/\.png$/, '-model.png');
                fs.writeFileSync(modelPath, Buffer.from(dataUrl.split(',')[1] ?? '', 'base64'));
                logLine(`[shot] 模型高清导出已保存：${modelPath}`);
              }
            } catch (e) {
              logLine(`[shot] 模型导出失败：${(e as Error).message}`);
            }
          } catch (e) {
            logLine(`[shot] 截图失败：${(e as Error).message}`);
          } finally {
            app.quit();
          }
        })();
      }, Number(process.env.SASSDESK_SHOT_DELAY ?? 7000));
    }
  });
}

function createInputWindow(): void {
  if (inputWin && !inputWin.isDestroyed()) {
    inputWin.show();
    inputWin.focus();
    return;
  }
  inputWin = new BrowserWindow({
    width: 320,
    height: 84,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(here, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  void inputWin.loadFile(path.join(rendererDir, "input.html"));
  inputWin.on("closed", () => (inputWin = null));
}

/**
 * 控制面板窗口：聊天（流式）+ 终端（CLI 入口）。
 * 入口：角色窗口双击 / 托盘「控制面板…」/ 面板内按钮。
 */
function createPanelWindow(): void {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.show();
    panelWin.focus();
    return;
  }
  panelWin = new BrowserWindow({
    width: 460,
    height: 620,
    minWidth: 380,
    minHeight: 420,
    backgroundColor: "#1a2029",
    title: "Sass 控制面板",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  void panelWin.loadFile(path.join(rendererDir, "panel.html"));
  panelWin.on("closed", () => (panelWin = null));
}

/** 聊天消息发送：走真实 Agent（与 CLI 同一内核），流式推送到面板。 */
async function handleChatSend(text: string): Promise<{ ok: boolean; reply: string }> {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, reply: "内容为空" };
  const store = chatStore;
  if (!store) return { ok: false, reply: "聊天存储未就绪" };
  store.append("user", trimmed);

  // API 关闭：不调用模型，明确告知
  if (!ctx.config.llm.enabled) {
    const tip = "当前未接入模型 API（纯命令模式）。在 CLI 里输入 /api on 可开启对话与任务能力。";
    store.append("system", tip);
    return { ok: false, reply: tip };
  }
  if (pet.state === "working") {
    const busy = "我正在忙，稍等一下下～";
    store.append("system", busy);
    return { ok: false, reply: "busy" };
  }

  try {
    if (!agent) agent = await ctx.ensureAgent();
    // 预留助手消息并流式更新
    const pending = store.append("assistant", "", { partial: true });
    streamingMsgId = pending.id;
    const unsubscribe = agent.subscribe(
      createChatEventBridge((delta) => {
        if (streamingMsgId) panelWin?.webContents.send("chat:delta", { id: streamingMsgId, text: delta });
      }),
    );
    const result = await pet.runWithAgent(agent, trimmed);
    unsubscribe();
    const reply = result.text.trim() !== "" ? result.text.trim() : result.errorMessage ?? "（这次没有文字回复）";
    store.updateLast(pending.id, { text: reply, partial: false });
    panelWin?.webContents.send("chat:done", { id: pending.id, text: reply, ok: !result.errorMessage });
    return { ok: !result.errorMessage, reply };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    const errMsg = store.append("assistant", `出错了…${msg}`);
    panelWin?.webContents.send("chat:done", { id: errMsg.id, text: errMsg.text, ok: false });
    return { ok: false, reply: msg };
  } finally {
    streamingMsgId = null;
  }
}

/** 聊天流式桥：累积本轮文本增量，整段推给面板（避免逐字 IPC 洪泛）。 */
function createChatEventBridge(onText: (full: string) => void) {
  let acc = "";
  return createEventBridge({
    onTextDelta: (d) => {
      acc += d;
      onText(acc);
    },
  });
}

/** 打开 CLI 窗口：独立终端跑 CLI REPL（与桌宠/面板互不干扰）。 */
function openCliWindow(): { ok: boolean; message: string } {
  try {
    const projectRoot = root();
    const isWin = process.platform === "win32";
    if (isWin) {
      const child = spawn("cmd.exe", ["/c", "npm start"], {
        cwd: projectRoot,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } as NodeJS.ProcessEnv,
      });
      child.unref();
      return { ok: true, message: "CLI 窗口已打开（新终端窗口）" };
    }
    // 非 Windows：回退为提示
    return { ok: false, message: "非 Windows 环境：请在终端运行 npm start" };
  } catch (e) {
    return { ok: false, message: `启动失败：${(e as Error).message}` };
  }
}

function createTray(): void {
  const iconPath = path.join(charAssetsDir, "idle", "idle.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("SassDesk - Sass（萨斯）");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "控制面板（聊天）…", click: () => createPanelWindow() },
      { label: "对话输入框…", click: () => createInputWindow() },
      { label: "打开 CLI 窗口", click: () => openCliWindow() },
      { type: "separator" },
      { label: "显示桌宠", click: () => createPetWindow() },
      { label: "隐藏桌宠", click: () => petWin?.hide() },
      { type: "separator" },
      { label: "退出 SassDesk", click: () => app.quit() },
    ]),
  );
  tray.on("double-click", () => createPanelWindow());
}

async function handleSubmit(text: string): Promise<{ ok: boolean; reply: string }> {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, reply: "内容为空" };
  if (!agent) {
    agent = await ctx.ensureAgent();
  }
  if (pet.state === "working") {
    pushBubble("上一个任务还在跑，稍等一下下…", true);
    return { ok: false, reply: "busy" };
  }
  pushBubble("让我来试试！", true); // Sass 口头禅
  try {
    const result = await pet.runWithAgent(agent, trimmed);
    const reply = result.text.trim() !== "" ? result.text.trim() : result.errorMessage ?? "(没有文本回复)";
    pushBubble(reply.slice(0, 90));
    return { ok: !result.errorMessage, reply };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    pushBubble(`出错了…${msg.slice(0, 60)}`, false);
    return { ok: false, reply: msg };
  }
}

app.whenReady().then(() => {
  ctx = bootstrapApp();
  manifest = loadManifest();
  live2dModelUrl = resolveLive2dModel();
  startModelServer();

  chatStore = new ChatStore(ctx.dataDir);

  pet = new PetController();
  pet.subscribe(({ from, to, reason }) => {
    pushState(to, reason);
  });
  createPetWindow();
  createTray();
  startCursorPolling();

  // 开发自测：SASSDESK_SMOKE=cli → 验证 CLI 窗口拉起
  if (process.env.SASSDESK_SMOKE === "cli") {
    setTimeout(() => {
      const r = openCliWindow();
      logLine(`[smoke-cli] ${r.ok ? "ok" : "fail"}：${r.message}`);
      setTimeout(() => app.quit(), 6_000);
    }, 2_000);
  }
  // 开发自测：SASSDESK_SMOKE=chat → 自动跑一遍「面板 → 聊天 → 流式 → 持久化」链路后退出
  if (process.env.SASSDESK_SMOKE === "chat") {
    setTimeout(() => {
      void (async () => {
        try {
          createPanelWindow();
          panelWin?.webContents.on("console-message", (_e, _l, message) => logLine(`[panel] ${message}`));
          panelWin?.webContents.on("did-finish-load", () => logLine("[smoke] 面板页面加载完成"));
          panelWin?.webContents.on("did-fail-load", (_e, code, desc) => logLine(`[smoke] 面板加载失败 ${code} ${desc}`));
          logLine("[smoke] 面板窗口已创建");
          const res = await handleChatSend("请用一句话介绍你自己");
          logLine(`[smoke] 聊天结果（${res.ok ? "ok" : "fail"}）：${res.reply.slice(0, 140)}`);
          const fresh = new ChatStore(ctx.dataDir);
          const msgs = fresh.list();
          logLine(`[smoke] 持久化消息数：${msgs.length}（最后一条角色：${msgs[msgs.length - 1]?.role ?? "无"}）`);
          // 面板界面截图（聊天页 + 终端页）
          const shotBase = process.env.SASSDESK_PANEL_SHOT;
          if (shotBase && panelWin && !panelWin.isDestroyed()) {
            await new Promise((r) => setTimeout(r, 800));
            const chatShot = await panelWin.webContents.capturePage();
            fs.writeFileSync(`${shotBase}-chat.png`, chatShot.toPNG());
            await panelWin.webContents.executeJavaScript('document.querySelector(\'[data-view="term"]\')?.click()');
            await new Promise((r) => setTimeout(r, 500));
            const termShot = await panelWin.webContents.capturePage();
            fs.writeFileSync(`${shotBase}-term.png`, termShot.toPNG());
            logLine(`[smoke] 面板截图已保存：${shotBase}-chat.png / ${shotBase}-term.png`);
          }
        } catch (e) {
          logLine(`[smoke] 失败：${(e as Error).message}`);
        } finally {
          setTimeout(() => app.quit(), 800);
        }
      })();
    }, 2_500);
  }

  ipcMain.handle("input:submit", (_e, text: string) => handleSubmit(text));
  ipcMain.handle("model:read", () => readModelFiles());
  // 控制面板：聊天
  ipcMain.handle("chat:history", () => chatStore?.list() ?? []);
  ipcMain.handle("chat:send", (_e, text: string) => handleChatSend(text));
  ipcMain.handle("chat:clear", () => {
    chatStore?.clear();
  });
  // 控制面板：CLI / 桌宠 / 面板自身
  ipcMain.handle("cli:open", () => openCliWindow());
  ipcMain.handle("pet:info", () => {
    const info = readPetInfoLocal();
    return { running: Boolean(info), port: info?.port };
  });
  ipcMain.on("panel:action", (_e, action: "back" | "close") => {
    if (action === "close") panelWin?.close();
    else panelWin?.hide(); // 回到桌宠
  });
  ipcMain.on("pet:openInput", () => createPanelWindow());
  ipcMain.handle("pet:show", () => createPetWindow());
  ipcMain.on("pet:diag", (_e, msg: string) => {
    logLine(`[SassDesk] 渲染诊断：${msg}`);
    // 回退等情况用气泡直接告知用户（渲染正常时不打扰）
    if (msg.includes("异常") || msg.includes("失败") || msg.includes("回退")) {
      setTimeout(() => pushBubble(msg.slice(0, 60), false), 500);
    }
  });

  // 启动指引：前 3 秒置顶吸引注意 + 气泡告知交互方式
  petWin?.setAlwaysOnTop(true);
  setTimeout(() => petWin?.setAlwaysOnTop(false), 3_000);
  setTimeout(() => pushBubble("你好！双击我可以派活；右键托盘也能找我～", true), 3_200);

  logLine("[SassDesk] 桌宠已启动（托盘可对话/隐藏/退出）。配置目录：" + ctx.configDir);
});

app.on("window-all-closed", () => {
  // 托盘常驻，不随窗口关闭退出
});
app.on("before-quit", () => {
  pet?.dispose();
});
