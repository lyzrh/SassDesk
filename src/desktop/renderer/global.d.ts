/** 渲染进程共享的全局桥声明（preload contextBridge 暴露的 window.sassdesk）。 */
export {};

export interface SassDeskBubbleData {
  text: string;
  accent?: boolean;
}

export interface SassDeskStateData {
  state: string;
  reason?: string;
}

export interface SassDeskPetConfig {
  manifest: {
    fallback: string;
    states: Record<string, { src: string; poster?: string; animation: string; label: string }>;
  };
  assetsDirUrl: string;
  /** Live2D 模型入口 URL（探测到 assets/models 下模型时提供）。 */
  live2dModelUrl?: string;
  /** 渲染参数（pma 预乘 alpha 匹配、分辨率倍数）。 */
  render?: { pma: boolean; scale: number; noMotion?: boolean };
}

export interface SassDeskCursorData {
  x: number; // -1..1（窗口中心为 0）
  y: number;
  inside: boolean;
}

export interface SassDeskBridge {
  onConfig(cb: (data: SassDeskPetConfig) => void): void;
  onState(cb: (data: SassDeskStateData) => void): void;
  onBubble(cb: (data: SassDeskBubbleData) => void): void;
  onCursor(cb: (data: SassDeskCursorData) => void): void;
  submit(text: string): Promise<{ ok: boolean; reply: string }>;
  openInput(): void;
  reportDiag(msg: string): void;
  readModelFiles(): Promise<{
    modelDirName: string;
    settings: {
      model: string;
      textures: string[];
      physics?: string;
      pose?: string;
      motions?: Record<string, Array<{ file: string }>>;
      layout?: { center_x?: number; center_y?: number; width?: number };
    };
    moc: Uint8Array;
    textures: Uint8Array[];
    motions: Record<string, Uint8Array[]>;
    pose?: Uint8Array;
  } | null>;
}

declare global {
  interface Window {
    sassdesk: SassDeskBridge;
  }
}
