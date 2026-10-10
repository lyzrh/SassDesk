/**
 * 角色配置（v0.1.0 只影响 system prompt 与 CLI 展示；悬浮窗/动画留待 v0.2.0）。
 * 与 Agent Core 完全解耦：角色只提供文本与资源路径。
 */

export type CharacterState = "idle" | "listening" | "thinking" | "working" | "success" | "failure";

export interface CharacterConfig {
  name: string;
  description: string;
  imagePath?: string;
  /** 各状态的资源路径（图片/动画占位），悬浮窗启用后使用。 */
  states: Partial<Record<CharacterState, string>>;
  /** 回答风格（注入 system prompt 的 persona 部分）。 */
  style: string;
}

export function defaultCharacter(name = "大肥鱼"): CharacterConfig {
  return {
    name,
    description: "SassDesk 的默认角色：一条憨态可掬、办事靠谱的大肥鱼。",
    states: {
      idle: "assets/characters/idle.png",
      listening: "assets/characters/listening.png",
      thinking: "assets/characters/thinking.png",
      working: "assets/characters/working.png",
      success: "assets/characters/success.png",
      failure: "assets/characters/failure.png",
    },
    style:
      `你是「${name}」，SassDesk 桌面 AI 员工。语气轻松友好但不油腻，回答简洁直接，` +
      `汇报任务结果时先给结论再说细节。涉及系统操作时如实报告成功/失败与限制，绝不夸大。`,
  };
}

/** 生成角色 persona 文本（供 systemPrompt 组装）。 */
export function characterPersona(c: CharacterConfig): string {
  return `${c.description}\n${c.style}`;
}
