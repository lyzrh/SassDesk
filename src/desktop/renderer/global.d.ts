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

/** 控制面板聊天消息视图 */
export interface ChatMessageView {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  ts: number;
  partial?: boolean;
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
  /** 聊天：历史（持久化 data/chat.json） */
  chatHistory(): Promise<ChatMessageView[]>;
  chatSend(text: string): Promise<{ ok: boolean; reply: string }>;
  chatClear(): Promise<void>;
  onChatDelta(cb: (data: { id: string; text: string }) => void): void;
  onChatDone(cb: (data: { id: string; text: string; ok: boolean }) => void): void;
  /** 打开 CLI 窗口（面板终端页入口） */
  openCli(): Promise<{ ok: boolean; message: string }>;
  /** 桌宠在线信息（面板展示） */
  petInfo(): Promise<{ running: boolean; port?: number }>;
  /** 显示桌宠窗口 */
  showPet(): Promise<void>;
  /** 面板自身动作：back=回到桌宠（隐藏面板），close=关闭 */
  panelAction(action: "back" | "close"): void;
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
