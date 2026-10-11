/**
 * Live2DL2DHost：基于模型作者同款库 `l2d`（MIT，hacxy）的渲染宿主。
 *
 * 为什么换用该库：自研 core 直调虽能出画面，但模型内使用 deformer 驱动的部件
 * （眼白/瞳孔等）位置错乱（参数正常、mesh 错位，三重环境验证一致）；作者库管线
 * 与模型站全量模型配套验证，直接走它的渲染/动作/表情/参数体系。
 *
 * 能力：
 * - load() 渲染 Cubism 2/6 模型（自动识别）
 * - 状态→动作组：语义组优先，按模型实际存在的组回退
 * - 参数编排：getParams() 拿参数元数据后按语义匹配（眼睛开合/头角度/眼球），
 *   实现眨眼、鼠标视线跟随——不硬编码参数 id，兼容不同模型
 */

import { init as l2dInit, type L2D } from "l2d";

interface ParamMeta {
  id: string;
  value: number;
  min: number;
  max: number;
  default: number;
}

/** 状态→动作组候选（按顺序取模型实际存在的第一个） */
const STATE_GROUPS: Record<string, string[]> = {
  idle: ["idle"],
  listening: ["listening", "idle"],
  thinking: ["thinking", "flick_head", "tap_body", "idle"],
  working: ["working", "type", "writing", "idle"],
  success: ["success", "happy", "cheer", "shake", "idle"],
  error: ["error", "pinch_in", "sad", "idle"],
  sleeping: ["sleeping", "sleep", "idle"],
  click: ["click", "tap_body", "tap"],
};

export class Live2DL2DHost {
  private l2d: L2D | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private state = "idle";
  private cursorX = 0;
  private cursorY = 0;
  private ids: Record<string, string> = {};
  private raf: number | null = null;
  private blinkCountdown = 2 + Math.random() * 3;
  private blinkPhase = -1;
  private smoothX = 0;
  private smoothY = 0;
  private last = 0;
  private groups: string[] = [];

  get ready(): boolean {
    return this.l2d !== null;
  }

  get canvasEl(): HTMLCanvasElement | null {
    return this.canvas;
  }

  private container: HTMLElement | null = null;

  async init(canvas: HTMLCanvasElement, modelUrl: string, scale = 1, position: [number, number] = [0, 0], container?: HTMLElement): Promise<void> {
    this.container = container ?? null;
    this.canvas = canvas;
    const l2d = l2dInit(canvas);
    this.l2d = l2d;
    await l2d.load({ path: modelUrl, scale, position, volume: 0, logLevel: "warn" });
    // 库会替换 canvas 元素（自管 WebGL context）——取真实 canvas、给 CSS 尺寸、入 DOM、触发 resize
    this.canvas = l2d.getCanvas();
    const c = this.canvas;
    if (c) {
      c.style.width = "240px";
      c.style.height = "260px";
      c.style.position = "absolute";
      c.style.left = "0";
      c.style.bottom = "0";
      if (!c.parentElement && this.container) this.container.appendChild(c);
      l2d.resize();
      console.log();
    }
    this.groups = Object.keys(l2d.getMotions());
    // 参数语义匹配（大小写/下划线无关；库的 id 可能是数值索引）
    const params = l2d.getParams() as ParamMeta[];
    const pick = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const found = params.find((p) => String(p.id).toLowerCase().replace(/_/g, "").includes(k));
        if (found) return String(found.id);
      }
      return undefined;
    };
    this.ids = {
      eyeL: pick("eyeopenl", "eyelopen") ?? "",
      eyeR: pick("eyeopenr", "eyeropen") ?? "",
      angleX: pick("anglex") ?? "",
      angleY: pick("angley") ?? "",
      ballX: pick("eyeballx") ?? "",
      ballY: pick("eyebally") ?? "",
      mouthY: pick("mouthopeny", "mouthopen") ?? "",
    };
    console.log(`[l2d] 模型加载完成，动作组: ${this.groups.join(",")}；参数示例: ${JSON.stringify(params.slice(0, 6))}；参数匹配: ${JSON.stringify(this.ids)}`);

    // 健康检查：库内部 rAF 驱动渲染，load 返回时首帧可能尚未绘制——延迟重采样
    await new Promise((r) => setTimeout(r, 1_200));
    let health = this.checkPixels();
    if (!health.ok) {
      await new Promise((r) => setTimeout(r, 900));
      health = this.checkPixels();
    }
    console.log();

    // 参数编排循环（渲染由库内部 rAF 驱动）
    this.last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(0.05, (t - this.last) / 1000);
      this.last = t;
      this.tick(dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** 每帧参数编排：眨眼 / 鼠标跟随 / 状态表情 */
  private tick(dt: number): void {
    const l2d = this.l2d;
    if (!l2d) return;
    const params: Record<string, number> = {};

    // 眨眼（sleeping 强制闭眼）
    if (this.blinkPhase < 0) {
      this.blinkCountdown -= dt;
      if (this.blinkCountdown <= 0) {
        this.blinkPhase = 0;
        this.blinkCountdown = 2 + Math.random() * 3;
      }
    } else {
      this.blinkPhase += dt / 0.15;
      if (this.blinkPhase >= 1) this.blinkPhase = -1;
    }
    let eye = this.blinkPhase < 0 ? 1 : Math.abs(Math.cos(Math.PI * this.blinkPhase));
    if (this.state === "sleeping") eye = 0;
    if (this.state === "listening") eye = Math.min(1, eye * 1.15);

    // 鼠标跟随（working/sleeping 不看鼠标）
    const lookMouse = this.state !== "working" && this.state !== "sleeping";
    const targetX = lookMouse ? this.cursorX * 30 : 0;
    const targetY = lookMouse ? -this.cursorY * 20 : this.state === "working" ? -10 : 0;
    const k = 1 - Math.pow(0.001, dt);
    this.smoothX += (targetX - this.smoothX) * k;
    this.smoothY += (targetY - this.smoothY) * k;

    const set = (key: string, v: number) => {
      if (this.ids[key]) params[this.ids[key]!] = v;
    };
    set("eyeL", eye);
    set("eyeR", eye);
    set("angleX", this.smoothX);
    set("angleY", this.smoothY);
    set("ballX", lookMouse ? this.cursorX : 0);
    set("ballY", lookMouse ? -this.cursorY : 0);
    if (this.state === "error") {
      set("angleX", Math.sin(performance.now() / 1000 * 3.2) * 8);
    }
    if (Object.keys(params).length > 0) l2d.setParams(params);
  }

  /** 状态切换：按语义组播放动作 */
  setState(state: string): void {
    this.state = state;
    const l2d = this.l2d;
    if (!l2d) return;
    const candidates = STATE_GROUPS[state] ?? ["idle"];
    const group = candidates.find((g) => this.groups.includes(g)) ?? this.groups[0];
    if (group) l2d.playMotion(group, 0, state === "idle" ? 1 : 3);
  }

  lookAt(x: number, y: number, _inside: boolean): void {
    this.cursorX = Math.max(-1, Math.min(1, x));
    this.cursorY = Math.max(-1, Math.min(1, y));
  }

  /** 点击动作 */
  tap(): void {
    const l2d = this.l2d;
    if (!l2d) return;
    const group = ["click", "tap_body", "tap"].find((g) => this.groups.includes(g));
    if (group) l2d.playMotion(group, 0, 3);
  }

  private checkPixels(): { ok: boolean; detail: string } {
    try {
      const c = document.createElement("canvas");
      const w = 120;
      const h = 130;
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      if (!ctx || !this.canvas) return { ok: false, detail: "2d ctx 不可用" };
      const src = this.canvas;
      if (!src || !src.width || !src.height) return { ok: false, detail: "canvas 无效（宽高 0）" };
      ctx.drawImage(src, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4) {
        if ((data[i] ?? 0) > 10) opaque++;
        if (opaque > 200) break;
      }
      return opaque > 200 ? { ok: true, detail: `非透明像素 ${opaque}+` } : { ok: false, detail: `画布空白（${opaque}）` };
    } catch (e) {
      return { ok: false, detail: "采样异常:" + (e as Error).message };
    }
  }

  destroy(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.l2d?.destroy?.();
    this.l2d = null;
  }
}
