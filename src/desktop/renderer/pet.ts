/**
 * 桌宠渲染进程逻辑：状态图加载（带三级回退与加载状态处理）+ 程序化动画 + 气泡。
 * 不接触 Node API，全部经 preload 暴露的 window.sassdesk（类型见 global.d.ts）。
 *
 * 图片加载状态（用户可见反馈）：
 * - loading：狐狸剪影 shimmer 占位动画
 * - loaded：平滑淡入（opacity 过渡）
 * - error：友好提示（仅当全部素材源失败）
 * 每次回退/失败都会 console.warn，由主进程转发用于排障。
 */

import type { SassDeskPetConfig } from "./global.js";

const img = document.getElementById("pet-img") as HTMLImageElement;
const bubble = document.getElementById("bubble") as HTMLDivElement;
const badge = document.getElementById("badge") as HTMLSpanElement;
const loadingEl = document.getElementById("loading") as HTMLDivElement;
const errorEl = document.getElementById("load-error") as HTMLDivElement;

let config: SassDeskPetConfig | null = null;
let currentState = "idle";
let bubbleTimer: ReturnType<typeof setTimeout> | undefined;
let loadSeq = 0; // 加载序号：防止快速切状态时旧图的 onload 晚到覆盖新状态

function setLoadPhase(phase: "loading" | "loaded" | "error"): void {
  img.dataset.load = phase;
  loadingEl.classList.toggle("hidden", phase !== "loading");
  errorEl.classList.toggle("hidden", phase !== "error");
}

/** 素材回退链：部件动画 SVG（manifest.src）→ AI 静态 PNG（poster）→ 占位 SVG → manifest.fallback。 */
function imageUrlsFor(state: string): string[] {
  const urls: string[] = [];
  if (config) {
    const st = config.manifest.states[state];
    if (st) {
      urls.push(config.assetsDirUrl + st.src);
      if (st.poster) urls.push(config.assetsDirUrl + st.poster);
      urls.push(`${config.assetsDirUrl}${state}/placeholder.svg`);
      urls.push(config.assetsDirUrl + config.manifest.fallback);
    }
  }
  return urls;
}

function applyState(state: string, reason?: string): void {
  currentState = state;
  const st = config?.manifest.states[state];
  img.dataset.anim = st?.animation ?? "breathe";
  badge.textContent = st?.label ?? state;
  loadImageWithFallback(imageUrlsFor(state));
  if (state === "error" && reason) {
    showBubble(`遇到问题了…${reason}`.slice(0, 90), false);
  }
}

function loadImageWithFallback(urls: string[]): void {
  const seq = ++loadSeq;
  if (urls.length === 0) {
    console.warn("[pet] 无可用素材 URL（config 未就绪或状态缺失）");
    setLoadPhase("error");
    return;
  }
  setLoadPhase("loading");

  const tryLoad = (index: number): void => {
    const url = urls[index];
    if (url === undefined) {
      console.error(`[pet] 全部素材源加载失败（状态 ${currentState}），已尝试 ${urls.length} 个`);
      setLoadPhase("error");
      return;
    }
    img.onerror = () => {
      console.warn(`[pet] 素材加载失败(${index + 1}/${urls.length})：${url}`);
      if (seq === loadSeq) tryLoad(index + 1);
    };
    img.onload = () => {
      if (seq !== loadSeq) return; // 旧图晚到，丢弃
      console.log(`[pet] 素材加载成功：${url}`);
      setLoadPhase("loaded"); // 触发 CSS 淡入
    };
    img.src = url;
  };
  tryLoad(0);
}

function showBubble(text: string, accent = false): void {
  bubble.innerHTML = "";
  const span = document.createElement("span");
  if (accent) span.className = "accent";
  span.textContent = text; // textContent 防注入
  bubble.appendChild(span);
  bubble.classList.add("show");
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubble.classList.remove("show"), 6000);
}

if (!window.sassdesk) {
  // preload 未注入（contextIsolation/preload 失败）：显示错误状态并打日志，而不是静默空白
  console.error("[pet] window.sassdesk 不存在——preload 未成功注入！检查 preload.mjs 路径与 sandbox 设置");
  setLoadPhase("error");
  (errorEl.querySelector(".tip") as HTMLElement).textContent = "preload 未加载，请重启桌宠";
} else {
  let host: import("./live2d-l2d.js").Live2DL2DHost | null = null;
  let usingLive2D = false;

  window.sassdesk.onConfig(async (data) => {
    config = data;
    console.log(`[pet] config 就绪：${Object.keys(data.manifest.states).length} 个状态，素材目录 ${data.assetsDirUrl}`);
    // Live2D 优先：作者库 l2d（管线经模型站全量模型验证）
    if (data.live2dModelUrl) {
      // 有 Live2D 模型时隐藏 SVG rig，杜绝"狐狸闪现→模型"的两段式显示
      (document.getElementById("pet-img") as HTMLImageElement).style.display = "none";
      if (usingLive2D) return; // 已启用，不重复初始化
      setLoadPhase("loading");
      try {
        const { Live2DL2DHost } = await import("./l2d-bundle.js");
        const canvas = document.createElement("canvas");
        canvas.width = 480;
        canvas.height = 520;
        canvas.style.width = "240px";
        canvas.style.height = "auto";
        canvas.style.position = "absolute";
        canvas.style.left = "0";
        canvas.style.bottom = "0";
        const container = document.getElementById("l2d-container") as HTMLElement;
        // 先显示容器：作者库按容器尺寸计算 canvas 缓冲，隐藏容器会得到 0×0
        container.classList.remove("hidden");
        container.appendChild(canvas);
        host = new Live2DL2DHost();
        await host.init(canvas, data.live2dModelUrl, 1, [0, 0], container);
        usingLive2D = true;
        host.setState(currentState);
        loadingEl.classList.add("hidden");
        console.log("[pet] Live2D 引擎已启用（l2d）");
      } catch (e) {
        console.error("[pet] Live2D 初始化失败：" + (e as Error).message, (e as Error).stack);
        try {
          host?.destroy();
        } catch {
          /* 忽略 */
        }
        host = null;
        // 仅在 Live2D 真失败时回退内置角色
        (document.getElementById("l2d-container") as HTMLElement).classList.add("hidden");
        (document.getElementById("pet-img") as HTMLImageElement).style.display = "";
        loadingEl.classList.add("hidden");
        applyState(currentState);
        showBubble("Live2D 渲染不可用，已切换内置角色", true);
      }
      return;
    }
    // 无 Live2D 模型：使用内置 SVG rig
    applyState(currentState);
  });
  window.sassdesk.onState(({ state, reason }) => {
    if (usingLive2D && host) {
      host.setState(state);
      if (state === "error" && reason) showBubble(`遇到问题了…${reason}`.slice(0, 90), false);
      return;
    }
    applyState(state, reason);
  });
  window.sassdesk.onCursor(({ x, y, inside }) => {
    if (usingLive2D && host) host.lookAt(x, y, inside);
  });
  // 点击角色 → Live2D click 动作（m05）；双击 → 打开对话输入窗
  const petEl = document.getElementById("pet") as HTMLElement;
  petEl.addEventListener("click", () => {
    if (usingLive2D && host) host.tap();
  });
  petEl.addEventListener("dblclick", () => {
    window.sassdesk.openInput();
  });
  window.sassdesk.onBubble(({ text, accent }) => showBubble(text, accent));
}
