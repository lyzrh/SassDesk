/** 对话输入窗逻辑（无 Node API，全走 preload 桥，类型见 global.d.ts）。 */
const input = document.getElementById("text") as HTMLInputElement;
const sendBtn = document.getElementById("send") as HTMLButtonElement;

async function submit(): Promise<void> {
  const text = input.value.trim();
  if (text === "" || sendBtn.disabled) return;
  sendBtn.disabled = true;
  sendBtn.classList.add("busy");
  sendBtn.textContent = "…";
  try {
    const res = await window.sassdesk.submit(text);
    input.value = "";
    if (!res.ok) {
      input.placeholder = "出错了：" + res.reply.slice(0, 40);
    }
  } finally {
    sendBtn.disabled = false;
    sendBtn.classList.remove("busy");
    sendBtn.textContent = "发送";
    input.focus();
  }
}

sendBtn.addEventListener("click", () => void submit());
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void submit();
});
input.focus();
