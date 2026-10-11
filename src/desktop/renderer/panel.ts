/**
 * 控制面板渲染逻辑：聊天（流式）+ 终端（CLI 入口）。
 * 全部能力经 preload 的 window.sassdesk 暴露，无 Node 直连。
 */

interface ChatMessageView {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  ts: number;
}

const log = document.getElementById("chat-log") as HTMLDivElement;
const empty = document.getElementById("chat-empty") as HTMLDivElement;
const input = document.getElementById("chat-input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("chat-send") as HTMLButtonElement;
const stateChip = document.getElementById("state-chip") as HTMLSpanElement;
let streaming = false;

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function addMessage(m: ChatMessageView): HTMLElement {
  empty.style.display = "none";
  const wrap = document.createElement("div");
  wrap.className = `msg ${m.role}`;
  wrap.dataset.id = m.id;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = m.role === "user" ? "我" : m.role === "assistant" ? "Sass" : "系统";
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = m.text;
  wrap.append(meta, body);
  log.appendChild(wrap);
  scrollDown();
  return wrap;
}

function scrollDown(): void {
  log.scrollTop = log.scrollHeight;
}

function setBusy(busy: boolean): void {
  streaming = busy;
  sendBtn.disabled = busy;
  sendBtn.textContent = busy ? "…" : "发送";
  stateChip.classList.toggle("busy", busy);
  stateChip.textContent = busy ? "回应中…" : "待机";
}

async function send(): Promise<void> {
  const text = input.value.trim();
  if (text === "" || streaming) return;
  input.value = "";
  addMessage({ id: `tmp-${Date.now()}`, role: "user", text, ts: Date.now() });
  setBusy(true);
  try {
    const res = await window.sassdesk.chatSend(text);
    if (!res.ok && res.reply !== "busy") {
      addMessage({ id: `sys-${Date.now()}`, role: "system", text: res.reply, ts: Date.now() });
    }
  } catch (e) {
    addMessage({ id: `sys-${Date.now()}`, role: "system", text: `发送失败：${(e as Error).message}`, ts: Date.now() });
  } finally {
    setBusy(false);
    input.focus();
  }
}

// 流式：主进程推送增量，直接追加到正在生成的气泡
window.sassdesk.onChatDelta(({ id, text }) => {
  const node = log.querySelector(`[data-id="${id}"]`);
  if (node) {
    const body = node.querySelector(".body") as HTMLElement | null;
    if (body) {
      body.textContent = text;
      node.classList.add("thinking");
      scrollDown();
      return;
    }
  }
  const wrap = addMessage({ id, role: "assistant", text, ts: Date.now() });
  wrap.classList.add("thinking");
});

window.sassdesk.onChatDone(({ id }) => {
  const node = log.querySelector(`[data-id="${id}"]`);
  node?.classList.remove("thinking");
  setBusy(false);
});

async function loadHistory(): Promise<void> {
  const history = await window.sassdesk.chatHistory();
  if (history.length === 0) return;
  empty.style.display = "none";
  for (const m of history) addMessage(m);
}

async function refreshPetConn(): Promise<void> {
  const dot = document.getElementById("pet-dot") as HTMLElement;
  const text = document.getElementById("pet-conn-text") as HTMLElement;
  const info = await window.sassdesk.petInfo();
  dot.classList.toggle("on", info.running);
  text.textContent = info.running ? `桌宠运行中（端口 ${info.port}）` : "桌宠未运行（托盘图标 → 显示桌宠）";
}

sendBtn.addEventListener("click", () => void send());
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
});

document.getElementById("btn-clear")?.addEventListener("click", () => {
  void window.sassdesk.chatClear().then(() => {
    log.innerHTML = "";
    log.appendChild(empty);
    empty.style.display = "";
  });
});

// 标签切换
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`view-${tab.dataset.view}`)?.classList.add("active");
    if (tab.dataset.view === "term") void refreshPetConn();
  });
});

document.getElementById("btn-cli")?.addEventListener("click", (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  btn.disabled = true;
  void window.sassdesk.openCli().then((r) => {
    btn.textContent = r.ok ? "已打开（新窗口）" : r.message;
    btn.disabled = false;
  });
});
document.getElementById("btn-pet-show")?.addEventListener("click", () => window.sassdesk.showPet());
document.getElementById("btn-back")?.addEventListener("click", () => window.sassdesk.panelAction("back"));
document.getElementById("btn-close")?.addEventListener("click", () => window.sassdesk.panelAction("close"));

void loadHistory();
input.focus();
