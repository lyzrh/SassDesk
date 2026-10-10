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
  let live2dHost: import("./live2d-host.js").Live2DHost | null = null;
  let usingLive2D = false;

  window.sassdesk.onConfig(async (data) => {
    config = data;
    console.log(`[pet] config 就绪：${Object.keys(data.manifest.states).length} 个状态，素材目录 ${data.assetsDirUrl}`);
    // Live2D 优先：主进程探测到模型时启用 PIXI 引擎（打包 bundle；失败则回退 SVG rig）
    if (data.live2dModelUrl && !usingLive2D) {
      try {
        const mod = (await import("./l2d-bundle.js")) as { Live2DHost: new (c: HTMLElement) => import("./live2d-host.js").Live2DHost };
        live2dHost = new mod.Live2DHost(document.getElementById("l2d-container") as HTMLElement);
        await live2dHost.init(data.live2dModelUrl);
        usingLive2D = true;
        (document.getElementById("l2d-container") as HTMLElement).classList.remove("hidden");
        (document.getElementById("pet-img") as HTMLImageElement).style.display = "none";
        loadingEl.classList.add("hidden");
        console.log("[pet] Live2D 引擎已启用");
        return;
      } catch (e) {
        console.warn(`[pet] Live2D 初始化失败，回退 SVG rig：${(e as Error).message}`);
      }
    }
    applyState(currentState);
  });
  window.sassdesk.onState(({ state, reason }) => {
    if (usingLive2D && live2dHost) {
      live2dHost.setState({ state, reason });
      if (state === "error" && reason) showBubble(`遇到问题了…${reason}`.slice(0, 90), false);
      return;
    }
    applyState(state, reason);
  });
  window.sassdesk.onCursor(({ x, y, inside }) => {
    if (usingLive2D && live2dHost) live2dHost.lookAt(x, y, inside);
  });
  // 点击角色 → Live2D click 动作（m05）；双击 → 打开对话输入窗
  const petEl = document.getElementById("pet") as HTMLElement;
  petEl.addEventListener("click", () => {
    if (usingLive2D && live2dHost) live2dHost.tap();
  });
  petEl.addEventListener("dblclick", () => {
    window.sassdesk.openInput();
  });  window.sassdesk.onBubble(({ text, accent }) => showBubble(text, accent));
}
