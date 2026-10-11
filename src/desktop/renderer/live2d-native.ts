/**
 * Live2DNative：Cubism 2 core 原生渲染器（官方 demo 标准模式）。
 *
 * 为什么不用 pixi-live2d-display：实测该库在本项目环境（多组 GPU 配置 + 两个独立浏览器）
 * 下 core.draw 每帧执行但输出像素恒为 0（中间层的 GL 状态/矩阵注入链路失效）。
 * 本实现直接使用 core 的官方 API：Live2DModelWebGL + MotionQueueManager + Live2DMotion。
 *
 * - 模型文件由主进程经 IPC 读入（绕开渲染层 file:// fetch 限制）
 * - core 渲染到自己的 WebGL canvas（alpha），DOM 直接显示 + CSS 缩放
 * - 动作：语义组 idle/thinking/working/success/click（Cubism2 .mtn）
 * - 眨眼：PARAM_EYE_L/R_OPEN 自实现；鼠标跟随：PARAM_ANGLE_X/Y + PARAM_EYE_BALL_X/Y
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface NativeModelFiles {
  /** model.json 解析结果 */
  settings: {
    model: string;
    textures: string[];
    physics?: string;
    pose?: string;
    motions?: Record<string, Array<{ file: string }>>;
    layout?: { center_x?: number; center_y?: number; width?: number };
  };
  moc: Uint8Array;
  /** 按 settings.textures 顺序 */
  textures: Uint8Array[];
  /** 语义组 → mtn 文件二进制（idle/thinking/working/success/click） */
  motions: Record<string, Uint8Array[]>;
  /** pose 文件二进制（可选，部件互斥显隐组） */
  pose?: Uint8Array;
}

/* ---------- Pose：部件互斥显隐组（Cubism2 pose.json，移植自 pixi-live2d-display） ---------- */

interface PoseParamRef {
  paramIndex: number;
  partsIndex: number;
  link: Array<{ paramIndex: number; partsIndex: number }>;
}

class PoseLite {
  private groups: PoseParamRef[][] = [];

  constructor(coreModel: any, json: any) {
    const PartsDataID = (window as unknown as { PartsDataID?: { getID(id: string): unknown } }).PartsDataID;
    if (!json?.parts_visible || !PartsDataID) return;
    for (const { group } of json.parts_visible) {
      const g: PoseParamRef[] = group.map(({ id, link }: { id: string; link?: Array<{ id: string }> }) => {
        const p: PoseParamRef = { paramIndex: -1, partsIndex: -1, link: [] };
        p.paramIndex = coreModel.getParamIndex(`VISIBLE:${id}`);
        p.partsIndex = coreModel.getPartsDataIndex(PartsDataID.getID(id));
        coreModel.setParamFloat(p.paramIndex, 1);
        for (const l of link ?? []) {
          const lp: { paramIndex: number; partsIndex: number } = { paramIndex: -1, partsIndex: -1 };
          lp.paramIndex = coreModel.getParamIndex(`VISIBLE:${l.id}`);
          lp.partsIndex = coreModel.getPartsDataIndex(PartsDataID.getID(l.id));
          coreModel.setParamFloat(lp.paramIndex, 1);
          p.link.push(lp);
        }
        return p;
      });
      // 初始：每组第一个部件可见
      g.forEach((p, i) => {
        const v = i === 0 ? 1 : 0;
        coreModel.setPartsOpacity(p.partsIndex, v);
        if (p.paramIndex >= 0) coreModel.setParamFloat(p.paramIndex, v);
        for (const lp of p.link) coreModel.setPartsOpacity(lp.partsIndex, v);
      });
      this.groups.push(g);
    }
    console.log(`[live2d-native] pose 组: ${this.groups.length}`);
  }

  /** 每帧：motion 设置的 VISIBLE: 参数决定各组显示哪个部件，opacity 渐变（500ms） */
  update(dt: number, coreModel: any): void {
    if (this.groups.length === 0) return;
    const step = dt / 0.5;
    for (const g of this.groups) {
      let visibleIndex = 0;
      let maxOpacity = -1;
      g.forEach((p, i) => {
        const op = p.paramIndex >= 0 ? coreModel.getParamFloat(p.paramIndex) : coreModel.getPartsOpacity(p.partsIndex);
        if (op > maxOpacity) {
          maxOpacity = op;
          visibleIndex = i;
        }
      });
      g.forEach((p, i) => {
        const target = i === visibleIndex ? 1 : 0;
        const cur = coreModel.getPartsOpacity(p.partsIndex);
        const next = target > cur ? Math.min(target, cur + step) : Math.max(target, cur - step);
        coreModel.setPartsOpacity(p.partsIndex, next);
        for (const lp of p.link) coreModel.setPartsOpacity(lp.partsIndex, next);
      });
    }
  }
}

const STATE_MOTION: Record<string, string> = {
  idle: "idle",
  thinking: "thinking",
  working: "working",
  success: "success",
};

/* ---------- .mtn 自实现播放器（绕开 core 的 Live2DMotion 黑盒） ---------- */

interface MtnMotion {
  fps: number;
  durationSec: number;
  tracks: Array<{ id: string; values: number[] }>;
}

/** 解析 .mtn 文本：# 注释、$fps=30、PARAM_*=v0,v1,v2...（各行帧数可不同） */
function parseMtn(text: string): MtnMotion | null {
  let fps = 30;
  const tracks: Array<{ id: string; values: number[] }> = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    if (t.startsWith("$fps=")) {
      fps = Number.parseFloat(t.slice(5)) || 30;
      continue;
    }
    if (t.startsWith("$")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const id = t.slice(0, eq).trim();
    const values = t
      .slice(eq + 1)
      .split(",")
      .map((s) => Number.parseFloat(s.trim()))
      .filter((v) => Number.isFinite(v));
    if (id && values.length > 0) tracks.push({ id, values });
  }
  if (tracks.length === 0) return null;
  const maxFrames = Math.max(...tracks.map((t) => t.values.length));
  return { fps, durationSec: Math.max(0.1, maxFrames / fps), tracks };
}

/** 线性插值采样一帧 */
function sampleTrack(values: number[], frame: number): number {
  const i = Math.floor(frame);
  const f = frame - i;
  const a = values[Math.min(i, values.length - 1)] ?? 0;
  const b = values[Math.min(i + 1, values.length - 1)] ?? a;
  return a + (b - a) * f;
}

/** 动作播放器：支持循环（idle）/一次性（完成后回调回 idle） */
class MotionPlayer {
  private motion: MtnMotion | null = null;
  private startTime = 0;
  private looping = false;
  private onEnd: (() => void) | undefined;

  play(motion: MtnMotion, loop: boolean, onEnd?: () => void): void {
    this.motion = motion;
    this.looping = loop;
    this.onEnd = onEnd;
    this.startTime = performance.now() / 1000;
  }

  stop(): void {
    this.motion = null;
    this.onEnd = undefined;
  }

  get playing(): boolean {
    return this.motion !== null;
  }

  update(model: any): void {
    if (!this.motion) return;
    let t = performance.now() / 1000 - this.startTime;
    if (t >= this.motion.durationSec) {
      if (this.looping) {
        t %= this.motion.durationSec;
      } else {
        const cb = this.onEnd;
        this.motion = null;
        cb?.();
        return;
      }
    }
    const frame = t * this.motion.fps;
    for (const tr of this.motion.tracks) {
      model.setParamFloat(tr.id, sampleTrack(tr.values, frame));
    }
  }
}

export class Live2DNative {
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGLRenderingContext | null = null;
  private model: any = null;
  private player = new MotionPlayer();
  private playerMotions: Record<string, MtnMotion[]> = {};
  private pose: PoseLite | null = null;
  private raf: number | null = null;
  private state: string = "idle";

  // 眨眼
  private blinkCountdown = 2 + Math.random() * 3;
  private blinkPhase = -1; // -1 未眨，0..1 进行中
  // 鼠标跟随（平滑目标）
  private cursorX = 0;
  private cursorY = 0;
  private angleX = 0;
  private angleY = 0;
  private eyeX = 0;
  private eyeY = 0;
  private idleMotionIndex = 0;
  private last = 0;
  private octx = 0;

  get ready(): boolean {
    return this.model !== null;
  }

  get canvasEl(): HTMLCanvasElement | null {
    return this.canvas;
  }

  async init(files: NativeModelFiles): Promise<void> {
    // Cubism 2 core 的类挂在不带命名空间的全局裸变量上（window.Live2D 只是版本函数）
    const g = window as unknown as {
      Live2DModelWebGL?: any;
      Live2DMotion?: any;
      MotionQueueManager?: any;
    };
    const Live2DModelWebGL = g.Live2DModelWebGL;
    // Live2DMotion 不再使用（.mtn 由自实现播放器解析）
    // MotionQueueManager 不再使用
    if (!Live2DModelWebGL) {
      throw new Error("Cubism 2 core 未加载（window.Live2DModelWebGL 缺失）");
    }

    // 1. 加载模型
    const mocBytes = files.moc;
    this.model = Live2DModelWebGL.loadModel(mocBytes.buffer as ArrayBuffer);
    if (!this.model) throw new Error("moc 解析失败");

    // 2. canvas + GL（core 自己的画布，官方模式）
    //    分辨率用显示尺寸的 2 倍（480×520）：过高（原始 1280×1380）经 CSS 缩小会发糊
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 520;
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL 不可用");
    gl.clearColor(0, 0, 0, 0);
    this.canvas = canvas;
    this.gl = gl;
    this.model.setGL(gl);

    // core 的 GL 上下文完整初始化（等价 pixi-live2d-display 的 updateWebGLContext）：
    // 1) firstDraw 重置  2) 清掉跨上下文缓存的 WebGLBuffer  3) clipManager 遮罩渲染纹理——
    // 缺第 3 步时，带遮罩的模型（hallo 有）绘制会在 undefined 的 GL 上 createProgram 而崩溃
    const drawParamWebGL = this.model.drawParamWebGL;
    drawParamWebGL.firstDraw = true;
    drawParamWebGL.setGL(gl);
    drawParamWebGL.glno = 1;
    for (const prop in drawParamWebGL) {
      if (Object.prototype.hasOwnProperty.call(drawParamWebGL, prop) && drawParamWebGL[prop] instanceof WebGLBuffer) {
        drawParamWebGL[prop] = null;
      }
    }
    const clipManager = this.model.getModelContext().clipManager;
    clipManager.curFrameNo = 1;
    // 先设主 viewport，让 mask FBO 以正确尺寸创建
    gl.viewport(0, 0, canvas.width, canvas.height);
    const boundFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    clipManager.getMaskRenderTexture();
    gl.bindFramebuffer(gl.FRAMEBUFFER, boundFramebuffer);
    // mask 渲染会改 viewport（mask FBO 尺寸），clip 后必须恢复主 viewport——否则主绘制错乱
    const originalSetupClip = clipManager.setupClip;
    clipManager.setupClip = (modelContext: unknown, drawParam: { gl: WebGLRenderingContext }) => {
      originalSetupClip.call(clipManager, modelContext, drawParam);
      drawParam.gl.viewport(0, 0, canvas.width, canvas.height);
    };

    // 3. 贴图（Cubism2 贴图需 flipY）
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    for (let i = 0; i < files.textures.length; i++) {
      const img = await this.decodeImage(files.textures[i]!);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      this.model.setTexture(i, tex);
    }

    // 4. 动作解析（.mtn 文本 → 自实现播放器）
    for (const [group, list] of Object.entries(files.motions)) {
      const parsed = list
        .map((buf) => parseMtn(new TextDecoder("utf-8").decode(buf)))
        .filter((m): m is MtnMotion => m !== null);
      this.playerMotions[group] = parsed;
      console.log(`[live2d-native] 动作组 ${group}: ${parsed.length} 个解析成功`);
    }

    // 4.5 pose（部件互斥显隐组）：shizuku 等模型的重影/错乱多因缺 pose
    if (files.pose) {
      try {
        const poseJson = JSON.parse(new TextDecoder("utf-8").decode(files.pose));
        this.pose = new PoseLite(this.model, poseJson);
      } catch (e) {
        console.warn(`[live2d-native] pose 解析失败: ${(e as Error).message}`);
      }
    }

    // 5. 矩阵：模型画布 (0..W, 0..H) → NDC 全画布，模型完整显示
    //    （hallo 自带的 layout=width 2.7/center_y -0.6 是 Live2DViewerEX 大窗口配置，
    //     在 240×280 桌宠窗口会把模型放大下移到几乎全出屏，故不采用）
    const cw = this.model.getCanvasWidth();
    const ch = this.model.getCanvasHeight();
    const m = [
      2 / cw, 0, 0, 0,
      0, -2 / ch, 0, 0,
      0, 0, 1, 0,
      -1, 1, 0, 1,
    ];
    this.model.setMatrix(m);
    console.log(`[live2d-native] 布局: 画布 ${cw}×${ch} → 窗口全显（忽略 viewer 专属 layout）`);

    // 6. 首帧渲染 + 像素健康检查（模型必须真实输出像素）
    await this.renderFrame(0);
    const health = this.checkPixels(gl, canvas.width, canvas.height);
    console.log(`[live2d-native] 健康检查: ${health.ok ? "通过" : "失败"} - ${health.detail}（渲染画布 ${canvas.width}×${canvas.height}）`);
    if (!health.ok) throw new Error(`模型无像素输出（${health.detail}）`);

    // 7. 启动循环
    this.playGroup("idle");
    this.last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(0.05, (t - this.last) / 1000);
      this.last = t;
      void this.renderFrame(dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    console.log("[live2d-native] 渲染循环已启动");
    // 高清模型导出（调试）：主进程 executeJavaScript 调用，返回 canvas 原始渲染（1800×2200）
    (window as unknown as { __live2dCanvasShot?: () => string }).__live2dCanvasShot = () => this.canvas!.toDataURL("image/png");
  }

  /** 解码贴图 bytes → ImageBitmap。 */
  private async decodeImage(data: Uint8Array): Promise<ImageBitmap> {
    const blob = new Blob([data.buffer as ArrayBuffer], { type: "image/png" });
    return await createImageBitmap(blob);
  }

  /** 首帧/每帧渲染。 */
  private async renderFrame(dt: number): Promise<void> {
    if (!this.model || !this.gl) return;
    const gl = this.gl;
    this.octx += dt;

    // 动作播放（自实现播放器）
    this.player.update(this.model);
    // pose 应用（motion 的 VISIBLE: 参数 → 部件互斥渐变）
    this.pose?.update(dt, this.model);

    // 眨眼/鼠标跟随/摇头：**仅在无动作播放时**应用——
    // 模型的 idle 动作自带完整表情（眨眼/眼球/头部），叠加覆盖会造成"白线眼"等表情崩坏
    if (!this.player.playing) {
      if (this.state === "sleeping") {
        this.model.setParamFloat("PARAM_BREATH", ((Math.sin(this.octx * 1.6) + 1) / 2) * 0.6);
      } else if (this.state === "listening" || this.state === "error") {
        // 这些状态无动作：仅眨眼/跟随
      } else {
        // idle 类状态无动作兜底：轻呼吸
        this.model.setParamFloat("PARAM_BREATH", (Math.sin(this.octx * 1.8) + 1) / 2);
      }
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
      const eye = this.blinkPhase < 0 ? 1 : Math.abs(Math.cos(Math.PI * this.blinkPhase));
      this.model.setParamFloat("PARAM_EYE_L_OPEN", this.state === "sleeping" ? 0 : eye);
      this.model.setParamFloat("PARAM_EYE_R_OPEN", this.state === "sleeping" ? 0 : eye);

      const targetX = this.state === "sleeping" ? 0 : this.cursorX * 30;
      const targetY = this.state === "sleeping" ? -10 : -this.cursorY * 20;
      const k = 1 - Math.pow(0.001, dt);
      this.angleX += (targetX - this.angleX) * k;
      this.angleY += (targetY - this.angleY) * k;
      this.eyeX += (this.cursorX * 1 - this.eyeX) * k;
      this.eyeY += (-this.cursorY * 1 - this.eyeY) * k;
      this.model.setParamFloat("PARAM_ANGLE_X", this.angleX);
      this.model.setParamFloat("PARAM_ANGLE_Y", this.angleY);
      this.model.setParamFloat("PARAM_EYE_BALL_X", this.eyeX);
      this.model.setParamFloat("PARAM_EYE_BALL_Y", this.eyeY);
    }

    // error 状态摇头（叠加在动作之上，幅度小）
    if (this.state === "error") {
      this.octx += dt;
      this.model.setParamFloat("PARAM_ANGLE_Z", Math.sin(this.octx * 3.2) * 8);
    }

    // 一次性动作播完回 idle
    if (this.state !== "idle" && !this.player.playing) {
      this.state = "idle";
      this.playGroup("idle");
    }

    this.model.update();
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.model.draw();
  }

  /** 播放语义动作组。 */
  playGroup(group: string): void {
    const list = this.playerMotions[group];
    if (!list || list.length === 0) return;
    const idx = group === "idle" ? this.idleMotionIndex++ % list.length : 0;
    const motion = list[idx];
    if (!motion) return;
    this.player.play(motion, group === "idle");
  }

  /** 状态切换（由桌宠状态机驱动）。 */
  setState(state: string): void {
    if (state === this.state) return;
    this.state = state;
    const group = STATE_MOTION[state];
    if (group) {
      this.playGroup(group);
    } else {
      // listening/error/sleeping：停止动作，参数编排在 renderFrame 中处理
      this.player.stop();
    }
  }

  /** 点击反馈（m05）。 */
  tap(): void {
    this.playGroup("click");
  }

  /** 鼠标位置（-1..1，窗口中心为 0）。 */
  lookAt(x: number, y: number, _inside: boolean): void {
    this.cursorX = Math.max(-1, Math.min(1, x));
    this.cursorY = Math.max(-1, Math.min(1, y));
  }

  /** 像素健康检查：整体 alpha 采样（每 16 像素抽 1）。 */
  private checkPixels(gl: WebGLRenderingContext, width: number, height: number): { ok: boolean; detail: string } {
    try {
      const px = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let opaque = 0;
      for (let i = 3; i < px.length; i += 64) {
        if ((px[i] ?? 0) > 10) opaque++;
        if (opaque > 300) break;
      }
      return opaque > 300 ? { ok: true, detail: `采样非透明点 ${opaque}+` } : { ok: false, detail: `无输出像素（${opaque}）` };
    } catch (e) {
      return { ok: false, detail: "readPixels 异常:" + (e as Error).message };
    }
  }

  destroy(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.canvas?.remove();
    this.model = null;
    this.gl = null;
    this.player.stop();
  }
}
