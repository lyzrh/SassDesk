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
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } from "electron";
import { bootstrapApp, type AppContext } from "../app/bootstrap.js";
import { PetController } from "./pet-controller.js";

const here = path.dirname(fileURLToPath(import.meta.url)); // dist/desktop
const rendererDir = path.join(here, "renderer");

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
      console.log(`[SassDesk] 素材目录：${c}`);
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
let tray: Tray | null = null;
let agent: Awaited<ReturnType<AppContext["ensureAgent"]>> | null = null;
/** Live2D 模型配置（探测到 assets/models 下的 model*.json 时启用）。 */
let live2dModelUrl: string | undefined;

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
        console.log(`[SassDesk] Live2D 模型：${url}`);
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
  app.on("before-quit", () => clearInterval(timer));
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
    console.log(`[renderer] ${message} (${path.basename(sourceId)}:${line})`);
  });
  petWin.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[did-fail-load] ${code} ${desc} ${url}`);
  });
  void petWin.loadFile(path.join(rendererDir, "index.html"));
  petWin.webContents.on("did-finish-load", () => {
    petWin?.webContents.send("pet:config", {
      manifest,
      assetsDirUrl,
      live2dModelUrl,
    });
    pushState(pet.state);
    // 开发调试：SASSDESK_SHOT=<png路径> 时，等待渲染稳定后截取窗口画面并退出（用于验证视觉呈现）
    const shotPath = process.env.SASSDESK_SHOT;
    if (shotPath) {
      setTimeout(() => {
        void petWin?.webContents
          .capturePage()
          .then((img) => {
            fs.writeFileSync(shotPath, img.toPNG());
            console.log(`[shot] 窗口截图已保存：${shotPath}`);
            app.quit();
          })
          .catch((e: Error) => {
            console.error(`[shot] 截图失败：${e.message}`);
            app.quit();
          });
      }, 7_000);
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

function createTray(): void {
  const iconPath = path.join(charAssetsDir, "idle", "idle.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("SassDesk - Sass（萨斯）");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "对话…", click: () => createInputWindow() },
      { type: "separator" },
      { label: "显示桌宠", click: () => createPetWindow() },
      { label: "隐藏桌宠", click: () => petWin?.hide() },
      { type: "separator" },
      { label: "退出 SassDesk", click: () => app.quit() },
    ]),
  );
  tray.on("double-click", () => createInputWindow());
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

  pet = new PetController();
  pet.subscribe(({ from, to, reason }) => {
    pushState(to, reason);
  });
  createPetWindow();
  createTray();
  startCursorPolling();

  ipcMain.handle("input:submit", (_e, text: string) => handleSubmit(text));
  ipcMain.on("pet:openInput", () => createInputWindow());

  // 启动指引：前 3 秒置顶吸引注意 + 气泡告知交互方式
  petWin?.setAlwaysOnTop(true);
  setTimeout(() => petWin?.setAlwaysOnTop(false), 3_000);
  setTimeout(() => pushBubble("你好！双击我可以派活；右键托盘也能找我～", true), 3_200);

  console.log("[SassDesk] 桌宠已启动（托盘可对话/隐藏/退出）。配置目录：" + ctx.configDir);
});

app.on("window-all-closed", () => {
  // 托盘常驻，不随窗口关闭退出
});
app.on("before-quit", () => {
  pet?.dispose();
});
