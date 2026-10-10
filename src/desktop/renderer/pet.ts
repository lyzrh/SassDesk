/**
 * 桌宠渲染进程逻辑：状态图加载（带三级回退）+ 程序化动画 + 气泡。
 * 不接触 Node API，全部经 preload 暴露的 window.sassdesk（类型见 global.d.ts）。
 */

const img = document.getElementById("pet-img") as HTMLImageElement;
const bubble = document.getElementById("bubble") as HTMLDivElement;
const badge = document.getElementById("badge") as HTMLSpanElement;

let config: import("./global.js").SassDeskPetConfig | null = null;
let currentState = "idle";
let bubbleTimer: ReturnType<typeof setTimeout> | undefined;

/** 三级回退：状态正式图 → 状态占位图 → manifest.fallback → 内置 emoji。 */
function imageUrlsFor(state: string): string[] {
  const urls: string[] = [];
  if (config) {
    const st = config.manifest.states[state];
    if (st) {
      urls.push(`${config.assetsDirUrl}${st.src}`);
      urls.push(`${config.assetsDirUrl}${state}/placeholder.svg`);
      urls.push(`${config.assetsDirUrl}${config.manifest.fallback}`);
    }
  }
  return urls;
}

function applyState(state: string, reason?: string): void {
  currentState = state;
  const st = config?.manifest.states[state];
  img.dataset.anim = st?.animation ?? "breathe";
  badge.textContent = st?.label ?? state;
  loadWithFallback(imageUrlsFor(state), 0);
  if (state === "error" && reason) {
    showBubble(`遇到问题了…${reason}`.slice(0, 90), false);
  }
}

function loadWithFallback(urls: string[], index: number): void {
  const url = urls[index];
  if (url === undefined) {
    img.removeAttribute("src"); // 最终兜底：alt 文本，不崩溃
    return;
  }
  img.onerror = () => loadWithFallback(urls, index + 1);
  img.src = url;
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

window.sassdesk.onConfig((data) => {
  config = data;
  applyState(currentState);
});
window.sassdesk.onState(({ state, reason }) => applyState(state, reason));
window.sassdesk.onBubble(({ text, accent }) => showBubble(text, accent));
