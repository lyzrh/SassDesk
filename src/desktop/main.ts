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
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } from "electron";
import { bootstrapApp, type AppContext } from "../app/bootstrap.js";
import { PetController } from "./pet-controller.js";

const here = path.dirname(fileURLToPath(import.meta.url)); // dist/desktop
const rendererDir = path.join(here, "renderer");
const charAssetsDir = path.join(app.getAppPath(), "assets", "characters", "sass");
const assetsDirUrl = charAssetsDir.endsWith("\\") || charAssetsDir.endsWith("/")
  ? new URL(`file:///${charAssetsDir}`).href
  : new URL(`file:///${charAssetsDir}/`).href;

interface PetManifest {
  fallback: string;
  states: Record<string, { src: string; animation: string; label: string }>;
}

let ctx: AppContext;
let manifest: PetManifest;
let pet: PetController;
let petWin: BrowserWindow | null = null;
let inputWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let agent: Awaited<ReturnType<AppContext["ensureAgent"]>> | null = null;

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
  petWin = new BrowserWindow({
    width: 240,
    height: 280,
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
  void petWin.loadFile(path.join(rendererDir, "index.html"));
  petWin.webContents.on("did-finish-load", () => {
    petWin?.webContents.send("pet:config", {
      manifest,
      assetsDirUrl,
    });
    pushState(pet.state);
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

  pet = new PetController();
  pet.subscribe(({ from, to, reason }) => {
    pushState(to, reason);
  });
  createPetWindow();
  createTray();

  ipcMain.handle("input:submit", (_e, text: string) => handleSubmit(text));

  console.log("[SassDesk] 桌宠已启动（托盘可对话/隐藏/退出）。配置目录：" + ctx.configDir);
});

app.on("window-all-closed", () => {
  // 托盘常驻，不随窗口关闭退出
});
app.on("before-quit", () => {
  pet?.dispose();
});
