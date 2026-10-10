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
}

export interface SassDeskBridge {
  onConfig(cb: (data: SassDeskPetConfig) => void): void;
  onState(cb: (data: SassDeskStateData) => void): void;
  onBubble(cb: (data: SassDeskBubbleData) => void): void;
  submit(text: string): Promise<{ ok: boolean; reply: string }>;
}

declare global {
  interface Window {
    sassdesk: SassDeskBridge;
  }
}
