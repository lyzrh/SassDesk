/**
 * Live2DHost：Cubism 2 模型渲染宿主（pixi.js 6 + pixi-live2d-display 0.4）。
 *
 * - 模型：assets/models/<name>/model*.json（含语义化动作组 idle/thinking/working/success/click）
 * - 状态→动作：idle/thinking/working/success 播放对应组；idle 组由 MotionManager 自动循环
 * - listening/error/sleeping：无专属动作 → 参数编排（闭眼/摇头/下垂）+ 缩放反馈
 * - 鼠标跟随：focus(窗口内坐标)；点击：click 动作
 * - 语音：模型 tap 组带 mp3，已从适配配置中剔除，不播放
 *
 * 本模块经 esbuild 打包为 l2d-bundle.js（pixi/live2d-display 内联），渲染层以相对路径导入。
 */
import * as PIXI from "pixi.js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as l2dNs from "pixi-live2d-display/cubism2";

export interface Live2DStateData {
  state: string;
  reason?: string;
}

export interface Live2DCursorData {
  x: number; // -1..1（窗口中心为 0）
  y: number;
  inside: boolean;
}

const STATE_MOTION: Record<string, string> = {
  idle: "idle",
  thinking: "thinking",
  working: "working",
  success: "success",
};

export class Live2DHost {
  private app: unknown = null;
  private model: any = null;
  private container: HTMLElement;
  private canvas: HTMLCanvasElement | null = null;
  private state: string = "idle";
  private wobbleT = 0;
  private baseScale = 1;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  get ready(): boolean {
    return this.model !== null;
  }

  async init(modelUrl: string): Promise<void> {
    const Live2DModel = (l2dNs as { Live2DModel?: unknown }).Live2DModel as any;
    if (!Live2DModel) throw new Error("pixi-live2d-display 加载失败（未找到 Live2DModel 导出）");
    if (!(window as unknown as { Live2D?: unknown }).Live2D) throw new Error("Cubism 2 core（window.Live2D）未加载");

    const app = new PIXI.Application({ width: 240, height: 280, backgroundAlpha: 0, autoDensity: true, resolution: window.devicePixelRatio || 1 });
    this.app = app;
    this.canvas = app.view as HTMLCanvasElement;
    this.canvas.style.width = "240px";
    this.canvas.style.height = "280px";
    this.container.appendChild(this.canvas);

    this.model = await Live2DModel.from(modelUrl, { autoInteract: false });
    app.stage.addChild(this.model as never);

    // 布局：把模型自然尺寸缩放适配 240×280 并居中
    // 注意：Live2DModel(Cubism2) 继承 PIXI.Container，没有 anchor —— 必须用"中心减半尺寸"定位
    const mw = (this.model.width as number) || 0;
    const mh = (this.model.height as number) || 0;
    this.natW = mw;
    this.natH = mh;
    console.log(`[live2d] 模型自然尺寸: ${mw}×${mh}`);
    const scale = mw > 0 && mh > 0 ? Math.min(240 / mw, 280 / mh) * 1.05 : 1;
    this.baseScale = scale;
    this.applyLayout(scale);
    console.log(`[live2d] 布局: scale=${scale.toFixed(4)}`);

    // 每帧钩子：error 摇头 / sleeping 闭眼呼吸
    app.ticker.add(() => this.onFrame());
    console.log("[live2d] 模型加载完成:", modelUrl);

    // 渲染健康检查：PIXI 基础渲染链是否真的输出像素（透明窗口/无 GPU 环境会静默失败）
    const health = await this.checkRendering(app);
    console.log(`[live2d] 渲染健康检查: ${health.ok ? "通过" : "失败"} - ${health.detail}`);
    this.reportDiag(health.ok ? "Live2D 渲染正常" : `渲染异常（${health.detail}）`);
    if (!health.ok) {
      throw new Error(`画布无输出（${health.detail}），将回退内置角色`);
    }

    // 渲染自检（诊断 WebGL/尺寸/可见性）
    setTimeout(() => console.log("[live2d] 自检:", this.debugInfo()), 1_500);
  }

  /** 渲染健康检查：画红块 → 采样像素 → 移除。返回是否可见。 */
  private async checkRendering(app: PIXI.Application): Promise<{ ok: boolean; detail: string }> {
    const g = new PIXI.Graphics();
    g.beginFill(0xff0000, 0.95);
    g.drawRect(0, 0, 40, 40);
    g.endFill();
    app.stage.addChild(g as never);
    await new Promise((r) => setTimeout(r, 600));
    try {
      const ext = (app.renderer as unknown as { extract: { pixels(): Uint8Array } }).extract;
      const px = ext.pixels();
      let red = 0;
      for (let i = 0; i < px.length; i += 4) {
        if ((px[i] ?? 0) > 180 && (px[i + 1] ?? 255) < 100) red++;
        if (red > 40) break;
      }
      return red > 40 ? { ok: true, detail: `红块采样 ${red}+ 像素` } : { ok: false, detail: "画布全透明（GPU 合成受限）" };
    } catch (e) {
      return { ok: false, detail: "采样异常:" + (e as Error).message };
    } finally {
      app.stage.removeChild(g as never);
      g.destroy();
    }
  }

  /** 上报诊断信息（主进程用气泡展示给用户）。 */
  private reportDiag(msg: string): void {
    try {
      (window as unknown as { sassdesk?: { reportDiag?: (m: string) => void } }).sassdesk?.reportDiag?.(msg);
    } catch {
      // 诊断通道不可用不影响主流程
    }
  }

  /** 渲染状态自检（排障用）。 */
  debugInfo(): string {
    const canvas = this.canvas;
    const rect = canvas?.getBoundingClientRect();
    const rendererType = (this.app as { renderer?: { type?: number; width?: number; height?: number } })?.renderer;
    let glLost = "n/a";
    try {
      const gl = canvas?.getContext("webgl") as WebGLRenderingContext | null;
      glLost = gl ? String(gl.isContextLost()) : "no-context";
    } catch (e) {
      glLost = "err:" + (e as Error).message;
    }
    const bounds = this.model?.getBounds?.();
    // 像素采样：从 PIXI 渲染目标读回，判断"画布上是否真的画了东西"（区分渲染层 vs 窗口合成层问题）
    let pixelNonZero = "n/a";
    try {
      const extract = (this.app as { renderer?: { extract?: { pixels(): Uint8Array } } })?.renderer?.extract;
      if (extract) {
        const px = extract.pixels();
        let nonZero = 0;
        for (let i = 3; i < px.length; i += 4) {
          if ((px[i] ?? 0) > 0) nonZero++;
          if (nonZero > 200) break;
        }
        pixelNonZero = nonZero > 200 ? `有内容(${nonZero}+ 非透明像素)` : `近全透明(${nonZero})`;
      }
    } catch (e) {
      pixelNonZero = "err:" + (e as Error).message;
    }
    return [
      `canvas=${canvas ? canvas.width + "x" + canvas.height : "无"}`,
      `rect=${rect ? `${rect.width.toFixed(0)}x${rect.height.toFixed(0)}@${rect.left.toFixed(0)},${rect.top.toFixed(0)}` : "无"}`,
      `rendererType=${rendererType?.type ?? "?"}(1=WebGL,2=Canvas) ${rendererType?.width}x${rendererType?.height}`,
      `glContextLost=${glLost}`,
      `modelVisible=${this.model?.visible} alpha=${this.model?.alpha}`,
      `bounds=${bounds ? `${bounds.x.toFixed(0)},${bounds.y.toFixed(0)},${bounds.width.toFixed(0)}x${bounds.height.toFixed(0)}` : "无"}`,
      `stageChildren=${(this.app as { stage?: { children?: unknown[] } })?.stage?.children?.length ?? "?"}`,
      `tickerStarted=${(this.app as { ticker?: { started?: boolean } })?.ticker?.started}`,
      `pixelSample=${pixelNonZero}`,
    ].join(" | ");
  }

  /** 状态切换：动作组播放 + 参数编排。 */
  setState(data: Live2DStateData): void {
    this.state = data.state;
    if (!this.model) return;
    const motionGroup = STATE_MOTION[data.state];
    if (motionGroup) {
      // FORCE(3)：打断当前动作立即切换；idle 组播完后 MotionManager 自动循环
      void this.model.motion(motionGroup, 0, 3);
    }
    if (data.state === "sleeping") {
      this.model.internalModel?.motionManager?.stopAllMotions?.();
    }
  }

  /** 全局鼠标跟随（窗口内坐标，超出窗口时 clamp 到边缘）。 */
  lookAt(x: number, y: number, inside: boolean): void {
    if (!this.model) return;
    const cx = Math.max(-10, Math.min(250, 120 + x * 130));
    const cy = Math.max(-10, Math.min(290, 140 + y * 150));
    // working/sleeping 有固定视线方向；其余状态看向鼠标
    if (this.state !== "working" && this.state !== "sleeping") {
      void this.model.focus(cx, cy);
    }
    void inside;
  }

  /** 点击反馈：m05 动作。 */
  tap(): void {
    if (!this.model) return;
    void this.model.motion("click", 0, 3);
  }

  /** 按缩放设置模型尺寸（保持居中）。 */
  private applyLayout(s: number): void {
    if (!this.model) return;
    const mw = (this.natW ?? 0) * s;
    const mh = (this.natH ?? 0) * s;
    (this.model as { scale: { set(x: number, y: number): void } }).scale.set(s, s);
    (this.model as { position: { set(x: number, y: number): void } }).position.set((240 - mw) / 2, (280 - mh) / 2);
  }

  private natW = 0;
  private natH = 0;

  /** 每帧：error 摇头 / sleeping 闭眼呼吸 / 尺寸兜底。 */
  private onFrame(): void {
    if (!this.model) return;
    this.wobbleT += 1 / 60;
    const core = this.model.internalModel?.coreModel;
    if (!core?.setParamFloat) return;
    switch (this.state) {
      case "sleeping": {
        // 闭眼 + 慢呼吸
        core.setParamFloat("PARAM_EYE_L_OPEN", 0);
        core.setParamFloat("PARAM_EYE_R_OPEN", 0);
        core.setParamFloat("PARAM_BREATH", ((Math.sin(this.wobbleT * 1.6) + 1) / 2) * 0.6);
        break;
      }
      case "error": {
        // 摇头 + 缩
        core.setParamFloat("PARAM_ANGLE_Z", Math.sin(this.wobbleT * 3.2) * 8);
        this.applyLayout(this.baseScale * 0.96);
        break;
      }
      case "listening": {
        core.setParamFloat("PARAM_EYE_L_OPEN", 1.1);
        core.setParamFloat("PARAM_EYE_R_OPEN", 1.1);
        break;
      }
      default:
        this.applyLayout(this.baseScale);
        break;
    }
  }

  destroy(): void {
    (this.app as { destroy?(o: boolean): void })?.destroy?.(true);
    this.canvas?.remove();
    this.model = null;
    this.app = null;
  }
}
