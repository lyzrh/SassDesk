# Sass 角色素材规范

> 角色：Sass（萨斯），灰蓝色小狐狸。视觉权威依据：`assets/reference/sass-character-sheet.jpg`（用户提供设定图）。
> 原则：**不得把概念图直接裁剪当桌宠素材**；素材缺失时回退占位图，绝不崩溃或空白。

## 目录结构

```
assets/characters/sass/
├─ manifest.json          # 状态→素材映射、帧率、动画类型、窗口/气泡配置
├─ placeholder.svg        # 通用回退占位图（manifest.fallback）
├─ idle/idle.png          # 状态素材（正式）或 placeholder.svg（占位）
├─ listening/listening.png
├─ thinking/thinking.png
├─ working/working.png
├─ success/success.png
├─ error/error.png
└─ sleeping/sleeping.png
```

## 状态与图片规格（7 种，v0.1.0 每状态 1 帧）

| 状态 | 动作要点 | 文件 | 规格 |
|---|---|---|---|
| IDLE | 自然待机、眨眼、轻微摇尾巴 | `idle/idle.png` | 240×240 PNG 透明底 |
| LISTENING | 竖起耳朵、专注聆听 | `listening/listening.png` | 同上 |
| THINKING | 歪头思考、轻微疑问动作 | `thinking/thinking.png` | 同上 |
| WORKING | 坐在电脑前认真工作 | `working/working.png` | 同上 |
| SUCCESS | 开心、尾巴翘起 | `success/success.png` | 同上 |
| ERROR | 困惑、沮丧（禁止恐怖/崩坏表情） | `error/error.png` | 同上 |
| SLEEPING | 趴着休息、轻微呼吸 | `sleeping/sleeping.png` | 同上 |

### 制作要求

1. **透明背景 PNG**，240×240（或 2x=480 供高清缩放），角色居中，脚底留 10px 余量。
2. 保持外形一致性：灰蓝毛发 + 白色脸颊/胸口/尾巴尖 + 深色连帽衫 + 科技蓝灯光耳机；配色 `#8DA3B8 / #5B7A99 / #FFFFFF / #2B3440 / #59C2FF`。
3. 单角色、无文字、无水印、无复杂背景、无粒子特效。
4. 多帧 sprite sheet 必须在 manifest 中声明 `frames`、`frameSize`、`fps` 与帧顺序（水平排列，从左到右）。
5. 状态差异靠**姿势与表情**表达，不靠文字气泡。

### 当前素材状态（如实记录）

- 正式 PNG：见 `manifest.json` 各状态的 `src`；由 AI 生成（白底 → 脚本去底转透明），已通过一致性检查。
- 占位 SVG：`scripts/gen-placeholder-svgs.mjs` 程序化生成的几何 Q 版狐狸（透明底、矢量、缩放清晰），作为缺图回退，**明确标注为占位**。
- 动画：v0.1.0 为单帧 + 程序化动画（`breathe` 呼吸缩放 / `bounce` 弹跳 / `tilt` 歪头 / `shake` 轻晃 / `breathe-slow` 慢呼吸），多帧序列动画留待素材补齐。

## 加载与回退规则

渲染层按 `manifest.states[state].src` 加载；文件缺失或解码失败 → 依次回退：`<state>/placeholder.svg` → `manifest.fallback` → 内置几何狐狸。**任何失败都不允许白屏或崩溃。**
