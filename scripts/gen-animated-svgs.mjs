/**
 * 生成 Sass 部件化动画 SVG（肢体动画：分层部件 + CSS 关键帧，Live2D 的简化原理）。
 *
 * 部件层级（后画的在上层）：
 *   tail-1(尾根) → tail-2(尾中) → tail-3(尾尖白)
 *   body(连帽衫躯干) → leg-l/leg-r(脚)
 *   head 组：ear-l/ear-r(含内耳) → face(脸+白颊口鼻) → eyes(可眨) → headset(耳机)
 *   props：laptop(工作) / stars(成功)
 *
 * 动画全部为 CSS keyframes（<img> 引用 SVG 时 SMIL/CSS 动画均生效，无脚本依赖）。
 * 关键技巧：transform-box: fill-box 让 transform-origin 以部件自身为基准。
 *
 * 运行：node scripts/gen-animated-svgs.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "assets", "characters", "sass", "animated");
fs.mkdirSync(outDir, { recursive: true });

/** 配色（对齐 manifest.visualSpec.palette 与角色设定图） */
const C = {
  fur: "#8DA3B8",
  furDark: "#5B7A99",
  furLight: "#A9BCCB",
  white: "#FDFEFF",
  hoodie: "#2B3440",
  hoodieLight: "#3A4756",
  tech: "#59C2FF",
  techDim: "#59C2FF66",
  eye: "#1E2A36",
  blush: "#F2A9B8",
  innerEar: "#C7D3DE",
  laptop: "#4A5568",
  screen: "#6FD3FF",
};

/**
 * 眼睛（睁/大/弯/闭/下垂），blink=是否包眨眼动画组
 */
function eyes(kind, blink) {
  const shapes = {
    open: `<circle cx="-13" cy="0" r="8.5" fill="${C.eye}"/><circle cx="-10.5" cy="-3" r="2.8" fill="#FFF"/><circle cx="13" cy="0" r="8.5" fill="${C.eye}"/><circle cx="15.5" cy="-3" r="2.8" fill="#FFF"/>`,
    wide: `<circle cx="-13" cy="0" r="10" fill="${C.eye}"/><circle cx="-10" cy="-3.5" r="3.6" fill="#FFF"/><circle cx="13" cy="0" r="10" fill="${C.eye}"/><circle cx="16" cy="-3.5" r="3.6" fill="#FFF"/>`,
    happy: `<path d="M-21 2 Q-13 -8 -5 2" stroke="${C.eye}" stroke-width="4.5" fill="none" stroke-linecap="round"/><path d="M5 2 Q13 -8 21 2" stroke="${C.eye}" stroke-width="4.5" fill="none" stroke-linecap="round"/>`,
    closed: `<path d="M-20 0 L-6 0" stroke="${C.eye}" stroke-width="4.5" stroke-linecap="round"/><path d="M6 0 L20 0" stroke="${C.eye}" stroke-width="4.5" stroke-linecap="round"/>`,
    down: `<path d="M-20 -1 Q-13 4 -6 -1" stroke="${C.eye}" stroke-width="4.5" fill="none" stroke-linecap="round"/><path d="M6 -1 Q13 4 20 -1" stroke="${C.eye}" stroke-width="4.5" fill="none" stroke-linecap="round"/>`,
  };
  const content = shapes[kind] ?? shapes.open;
  return blink
    ? `<g class="eyes" style="transform-box:fill-box;transform-origin:center">${content}</g>`
    : content;
}

/** 单只耳朵（side: l|r；droop: 下垂角度） */
function ear(side, droop = 0) {
  const mirror = side === "r" ? " scale(-1,1)" : "";
  return `<g class="ear ear-${side}" style="transform-box:fill-box;transform-origin:50% 100%">
    <g transform="translate(${side === "l" ? -22 : 22}, -34) rotate(${side === "l" ? -14 + droop : 14 - droop})${mirror}">
      <path d="M0 26 L-4 -22 L20 8 Z" fill="${C.furDark}"/>
      <path d="M2 18 L-1 -8 L13 8 Z" fill="${C.innerEar}"/>
      <path d="M-2 -22 L20 8" stroke="${C.furDark}" stroke-width="6" stroke-linecap="round" fill="none"/>
    </g>
  </g>`;
}

/** 头部整组（含耳机；headY 让头部可独立上下微动） */
function head(kind, opts = {}) {
  const { blush = false, mouth = "smile" } = opts;
  const mouths = {
    smile: `<path d="M-5 26 Q0 31 5 26" stroke="${C.eye}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`,
    small: `<path d="M-4 27 L4 27" stroke="${C.eye}" stroke-width="3.5" stroke-linecap="round"/>`,
    open: `<ellipse cx="0" cy="28" rx="6" ry="5" fill="${C.eye}"/><ellipse cx="0" cy="30" rx="3.5" ry="2.5" fill="${C.blush}"/>`,
    flat: `<path d="M-5 27 Q0 24 5 27" stroke="${C.eye}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`,
  };
  return `<g class="head" style="transform-box:fill-box;transform-origin:50% 95%">
    ${ear("l")}${ear("r")}
    <circle cx="0" cy="0" r="42" fill="${C.fur}"/>
    <path d="M0 34 Q-30 32 -36 6 Q-18 30 0 30 Q18 30 36 6 Q30 32 0 34 Z" fill="${C.white}"/>
    <ellipse cx="0" cy="38" rx="12" ry="8" fill="${C.white}"/>
    ${eyes(kind, kind === "open")}
    <path d="M-4 22 L4 22 L0 27 Z" fill="${C.eye}"/>
    ${mouths[mouth]}
    ${blush ? `<ellipse cx="-30" cy="14" rx="8" ry="4.5" fill="${C.blush}" opacity=".8"/><ellipse cx="30" cy="14" rx="8" ry="4.5" fill="${C.blush}" opacity=".8"/>` : ""}
    <!-- 耳机：头带 + 双耳罩 + 呼吸灯 -->
    <path d="M-40 -8 Q0 -52 40 -8" stroke="${C.hoodie}" stroke-width="9" fill="none" stroke-linecap="round"/>
    <rect x="-52" y="-12" width="14" height="22" rx="6" fill="${C.hoodie}"/>
    <rect x="38" y="-12" width="14" height="22" rx="6" fill="${C.hoodie}"/>
    <rect x="-49" y="-6" width="8" height="4" rx="2" fill="${C.tech}" class="glow"/>
    <rect x="41" y="-6" width="8" height="4" rx="2" fill="${C.tech}" class="glow"/>
    <circle cx="0" cy="-40" r="4.5" fill="${C.tech}" class="glow"/>
  </g>`;
}

/** 躯干（连帽衫）+ 脚；lie=趴姿（宽扁椭圆，供 sleeping） */
function body(lie = false) {
  if (lie) {
    return `<g class="body" style="transform-box:fill-box;transform-origin:50% 100%">
      <ellipse cx="0" cy="66" rx="60" ry="26" fill="${C.hoodie}"/>
      <ellipse cx="0" cy="60" rx="46" ry="18" fill="${C.hoodieLight}"/>
      <ellipse cx="-44" cy="72" rx="13" ry="7" fill="${C.fur}"/>
      <ellipse cx="44" cy="72" rx="13" ry="7" fill="${C.fur}"/>
    </g>`;
  }
  return `<g class="body" style="transform-box:fill-box;transform-origin:50% 100%">
    <rect x="-34" y="38" width="68" height="62" rx="26" fill="${C.hoodie}"/>
    <path d="M-24 46 Q0 30 24 46 L24 58 Q0 44 -24 58 Z" fill="${C.hoodieLight}"/>
    <path d="M-6 52 L-8 76" stroke="${C.techDim}" stroke-width="3" stroke-linecap="round"/>
    <path d="M6 52 L8 76" stroke="${C.techDim}" stroke-width="3" stroke-linecap="round"/>
    <rect x="-16" y="64" width="32" height="28" rx="12" fill="${C.white}"/>
    <ellipse cx="-18" cy="100" rx="14" ry="8" fill="${C.fur}"/>
    <ellipse cx="18" cy="100" rx="14" ry="8" fill="${C.fur}"/>
  </g>`;
}

/** 尾巴三节（首尾相接的圆，蓬松渐小）；pose: down|up|curl */
function tail(pose = "down") {
  const segs = {
    // [cx, cy, r, fill] —— 相邻圆心距 < r1+r2，保证视觉连续
    down: [[26, 88, 17, C.fur], [52, 97, 15, C.fur], [75, 103, 12.5, C.white]],
    up: [[28, 82, 17, C.fur], [50, 58, 15, C.fur], [64, 34, 12.5, C.white]],
    curl: [[28, 90, 17, C.fur], [58, 98, 15, C.fur], [80, 82, 12.5, C.white]],
  }[pose];
  const [a, b, c] = segs;
  return `<g class="tail tail-1" style="transform-box:fill-box;transform-origin:0% 50%">
    <circle cx="${a[0]}" cy="${a[1]}" r="${a[2]}" fill="${a[3]}"/>
    <g class="tail-2" style="transform-box:fill-box;transform-origin:0% 50%">
      <circle cx="${b[0]}" cy="${b[1]}" r="${b[2]}" fill="${b[3]}"/>
      <g class="tail-3" style="transform-box:fill-box;transform-origin:0% 50%">
        <circle cx="${c[0]}" cy="${c[1]}" r="${c[2]}" fill="${c[3]}"/>
      </g>
    </g>
  </g>`;
}

/** 手臂（side: l|r；armRotate 静态姿势角） */
function arm(side, armRotate = 0) {
  const mirror = side === "r" ? -1 : 1;
  return `<g class="arm arm-${side}" style="transform-box:fill-box;transform-origin:${side === "l" ? "100%" : "0%"} 15%">
    <g transform="translate(${mirror * 30}, 52) rotate(${mirror * armRotate})">
      <rect x="${side === "l" ? -10 : -4}" y="0" width="14" height="34" rx="7" fill="${C.hoodie}"/>
      <circle cx="${side === "l" ? -3 : 3}" cy="36" r="8" fill="${C.fur}"/>
    </g>
  </g>`;
}

/** 状态差异化：props 与静态姿势 */
function stateExtras(state) {
  switch (state) {
    case "working":
      return {
        props: `<g class="laptop"><rect x="-40" y="102" width="80" height="7" rx="2" fill="${C.laptop}"/><rect x="-34" y="82" width="68" height="21" rx="2" fill="#5B6B7E"/><rect x="-31" y="85" width="62" height="15" rx="2" fill="${C.screen}" opacity=".85"><animate attributeName="opacity" values=".85;.45;.85" dur="1.1s" repeatCount="indefinite"/></rect></g>`,
        armPose: { l: 24, r: 24 },
      };
    case "success":
      return { props: `<g class="stars">${[[ -62, -30, 6 ], [ 64, -44, 7 ], [ 58, 26, 5 ], [ -56, 30, 4 ]].map(([x, y, r]) => `<path class="star" style="transform-box:fill-box;transform-origin:center" transform="translate(${x}, ${y})" d="M0 ${-r} L${r * 0.3} ${-r * 0.3} L${r} 0 L${r * 0.3} ${r * 0.3} L0 ${r} L${-r * 0.3} ${r * 0.3} L${-r} 0 L${-r * 0.3} ${-r * 0.3} Z" fill="#FFD97A"/>`).join("")}</g>`, armPose: { l: -140, r: -140 } };
    case "thinking":
      return { armPose: { l: 0, r: -118 } };
    case "error":
      return { armPose: { l: 12, r: 12 } };
    default:
      return { armPose: { l: 0, r: 0 } };
  }
}

/** 每状态的 CSS 动画（部件级关键帧） */
function stateCss(state) {
  const common = `
    .tail-1, .tail-2, .tail-3 { animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
    .glow { animation: glowPulse 2s ease-in-out infinite; }
    @keyframes glowPulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
    .star { animation: starTwinkle 1.4s ease-in-out infinite; }
    @keyframes starTwinkle { 0%,100% { opacity: .25; transform: scale(.7); } 50% { opacity: 1; transform: scale(1.15); } }
  `;
  switch (state) {
    case "idle":
      return `${common}
      /* 眨眼：4.2s 周期中 91%~94% 闭眼 */
      .eyes { animation: blink 4.2s infinite; transform-box: fill-box; transform-origin: center; }
      @keyframes blink { 0%,90%,100% { transform: scaleY(1); } 92%,94.5% { transform: scaleY(.08); } }
      /* 尾巴三节波浪：相位差制造鞭状摆动 */
      .tail-1 { animation: tailA 2.6s infinite; }
      .tail-2 { animation: tailB 2.6s infinite; animation-delay: -.18s; }
      .tail-3 { animation: tailC 2.6s infinite; animation-delay: -.36s; }
      @keyframes tailA { 0%,100% { transform: rotate(-6deg); } 50% { transform: rotate(7deg); } }
      @keyframes tailB { 0%,100% { transform: rotate(4deg); } 50% { transform: rotate(-8deg); } }
      @keyframes tailC { 0%,100% { transform: rotate(6deg); } 50% { transform: rotate(-10deg); } }
      /* 呼吸 + 重心微移 */
      .body { animation: bodyBreathe 3.4s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 100%; }
      @keyframes bodyBreathe { 0%,100% { transform: scaleY(1); } 50% { transform: scaleY(1.03); } }
      .head { animation: headFloat 3.4s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 95%; }
      @keyframes headFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
      /* 耳朵偶发抖动 */
      .ear-l, .ear-r { animation: earTwitch 5.2s infinite; }
      .ear-r { animation-delay: -.35s; }
      @keyframes earTwitch { 0%,86%,100% { transform: rotate(0deg); } 89% { transform: rotate(-7deg); } 92% { transform: rotate(4deg); } 95% { transform: rotate(-2deg); } }
      `;
    case "listening":
      return `${common}
      .ear-l { animation: earListenL .9s ease-in-out infinite; }
      .ear-r { animation: earListenR .9s ease-in-out infinite; }
      @keyframes earListenL { 0%,100% { transform: rotate(-4deg); } 50% { transform: rotate(6deg); } }
      @keyframes earListenR { 0%,100% { transform: rotate(4deg); } 50% { transform: rotate(-6deg); } }
      .head { animation: headLean 1.8s ease-in-out infinite; }
      @keyframes headLean { 0%,100% { transform: translateY(0) rotate(0deg); } 50% { transform: translateY(-3px) rotate(2deg); } }
      .body { animation: bodyLean 1.8s ease-in-out infinite; }
      @keyframes bodyLean { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-2deg); } }
      .tail-1 { animation: tailFast 1.1s infinite; } .tail-2 { animation: tailFast 1.1s infinite -.15s; } .tail-3 { animation: tailFast 1.1s infinite -.3s; }
      @keyframes tailFast { 0%,100% { transform: rotate(5deg); } 50% { transform: rotate(-5deg); } }
      `;
    case "thinking":
      return `${common}
      .head { animation: headTiltThink 3.2s ease-in-out infinite; }
      @keyframes headTiltThink { 0%,100% { transform: rotate(-9deg); } 50% { transform: rotate(-5deg) translateY(-2px); } }
      .arm-r { animation: chinTap 2.4s ease-in-out infinite; }
      @keyframes chinTap { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-7deg); } }
      .tail-1 { animation: tailSlow 3.6s infinite; } .tail-2 { animation: tailSlow 3.6s infinite -.3s; } .tail-3 { animation: tailSlow 3.6s infinite -.6s; }
      @keyframes tailSlow { 0%,100% { transform: rotate(-4deg); } 50% { transform: rotate(5deg); } }
      .eyes { animation: none; }
      `;
    case "working":
      return `${common}
      /* 双爪交替打字 */
      .arm-l { animation: typeL .38s ease-in-out infinite alternate; }
      .arm-r { animation: typeR .38s ease-in-out infinite alternate; animation-delay: -.19s; }
      @keyframes typeL { from { transform: rotate(2deg) translateY(0); } to { transform: rotate(-2deg) translateY(2px); } }
      @keyframes typeR { from { transform: rotate(-2deg) translateY(2px); } to { transform: rotate(2deg) translateY(0); } }
      .head { animation: headFocus 2.2s ease-in-out infinite; }
      @keyframes headFocus { 0%,100% { transform: translateY(2px) rotate(0deg); } 50% { transform: translateY(4px) rotate(1.5deg); } }
      .body { animation: bodyStill 3s ease-in-out infinite; }
      @keyframes bodyStill { 0%,100% { transform: scaleY(1); } 50% { transform: scaleY(1.015); } }
      .tail-1 { animation: tailCalm 4s infinite; } .tail-2 { animation: tailCalm 4s infinite -.4s; } .tail-3 { animation: tailCalm 4s infinite -.8s; }
      @keyframes tailCalm { 0%,100% { transform: rotate(2deg); } 50% { transform: rotate(-3deg); } }
      `;
    case "success":
      return `${common}
      /* 弹跳庆祝 */
      .body, .head { animation: jump .55s ease-in-out infinite; }
      @keyframes jump { 0%,100% { transform: translateY(0); } 40% { transform: translateY(-9px); } 60% { transform: translateY(-9px); } }
      /* 双臂上举挥动 */
      .arm-l { animation: waveL .55s ease-in-out infinite alternate; }
      .arm-r { animation: waveR .55s ease-in-out infinite alternate; }
      @keyframes waveL { from { transform: rotate(-12deg); } to { transform: rotate(10deg); } }
      @keyframes waveR { from { transform: rotate(12deg); } to { transform: rotate(-10deg); } }
      /* 尾巴高频大幅摇摆 */
      .tail-1 { animation: tailJoy .42s infinite; } .tail-2 { animation: tailJoy .42s infinite -.14s; } .tail-3 { animation: tailJoy .42s infinite -.28s; }
      @keyframes tailJoy { 0%,100% { transform: rotate(12deg); } 50% { transform: rotate(-12deg); } }
      `;
    case "error":
      return `${common}
      /* 耳朵耷拉 + 轻微颤 */
      .ear-l { animation: earDroopL 2.4s ease-in-out infinite; }
      .ear-r { animation: earDroopR 2.4s ease-in-out infinite; }
      @keyframes earDroopL { 0%,100% { transform: rotate(20deg); } 50% { transform: rotate(24deg); } }
      @keyframes earDroopR { 0%,100% { transform: rotate(-20deg); } 50% { transform: rotate(-24deg); } }
      /* 身体萎缩 + 摇头 */
      .body { animation: shrink 2.4s ease-in-out infinite; }
      @keyframes shrink { 0%,100% { transform: scale(.97); } 50% { transform: scale(.945); } }
      .head { animation: headShake 2.4s ease-in-out infinite; }
      @keyframes headShake { 0%,100% { transform: rotate(-3deg) translateY(3px); } 50% { transform: rotate(3deg) translateY(4px); } }
      .tail-1 { animation: none; } .tail-2 { animation: none; } .tail-3 { animation: none; }
      `;
    case "sleeping":
      return `${common}
      /* 趴姿慢呼吸 */
      .body { animation: sleepBreathe 3.2s ease-in-out infinite; }
      @keyframes sleepBreathe { 0%,100% { transform: scaleY(1) translateY(0); } 50% { transform: scaleY(1.05) translateY(1px); } }
      .head { animation: sleepHead 3.2s ease-in-out infinite; }
      @keyframes sleepHead { 0%,100% { transform: translateY(0) rotate(0deg); } 50% { transform: translateY(2px) rotate(-2deg); } }
      .tail-1 { animation: tailSleep 4.5s infinite; } .tail-2 { animation: tailSleep 4.5s infinite -.5s; } .tail-3 { animation: tailSleep 4.5s infinite -1s; }
      @keyframes tailSleep { 0%,100% { transform: rotate(2deg); } 50% { transform: rotate(-2deg); } }
      .ear-l, .ear-r { animation: none; }
      `;
    default:
      return common;
  }
}

/** 生成一个状态的完整动画 SVG */
function animatedSvg(state) {
  const conf = {
    idle: { eye: "open", mouth: "smile", tail: "down", lie: false },
    listening: { eye: "wide", mouth: "small", tail: "down", lie: false },
    thinking: { eye: "down", mouth: "flat", tail: "curl", lie: false },
    working: { eye: "down", mouth: "small", tail: "down", lie: false },
    success: { eye: "happy", mouth: "open", tail: "up", lie: false },
    error: { eye: "down", mouth: "flat", tail: "down", lie: false, blush: true, droop: 26 },
    sleeping: { eye: "closed", mouth: "small", tail: "curl", lie: true },
  }[state];

  const { props, armPose } = stateExtras(state);
  const lie = conf.lie;
  // 部件局部坐标以头部 (0,0) 为中心，需平移到画布中下位置（240×240 画布）；趴姿压扁并上移贴地
  const groupTransform = lie ? "translate(120, 140) scale(1.04, .92)" : "translate(120, 128)";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240">
<!-- Sass animated rig (部件化肢体动画)：状态 ${state} -->
<style>
  * { transform-box: fill-box; }
  ${stateCss(state)}
</style>
<g transform="${groupTransform}">
  ${tail(conf.tail)}
  ${body(lie)}
  ${state === "working" || lie ? "" : `<g class="arm arm-l" style="transform-box:fill-box;transform-origin:100% 15%"><g transform="translate(-30, 52) rotate(${armPose?.l ?? 0})"><rect x="-10" y="0" width="14" height="34" rx="7" fill="${C.hoodie}"/><circle cx="-3" cy="36" r="8" fill="${C.fur}"/></g></g>`}
  <g class="head" style="transform-box:fill-box;transform-origin:50% 95%">
    ${ear("l", conf.droop ?? 0)}${ear("r", conf.droop ?? 0)}
    <circle cx="0" cy="0" r="42" fill="${C.fur}"/>
    <path d="M0 34 Q-30 32 -36 6 Q-18 30 0 30 Q18 30 36 6 Q30 32 0 34 Z" fill="${C.white}"/>
    <ellipse cx="0" cy="38" rx="12" ry="8" fill="${C.white}"/>
    ${eyes(conf.eye, conf.eye === "open")}
    <path d="M-4 22 L4 22 L0 27 Z" fill="${C.eye}"/>
    ${( { smile: `<path d="M-5 26 Q0 31 5 26" stroke="${C.eye}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`, small: `<path d="M-4 27 L4 27" stroke="${C.eye}" stroke-width="3.5" stroke-linecap="round"/>`, open: `<ellipse cx="0" cy="28" rx="6" ry="5" fill="${C.eye}"/><ellipse cx="0" cy="30" rx="3.5" ry="2.5" fill="${C.blush}"/>`, flat: `<path d="M-5 27 Q0 24 5 27" stroke="${C.eye}" stroke-width="3.5" fill="none" stroke-linecap="round"/>` })[conf.mouth]}
    ${conf.blush ? `<ellipse cx="-30" cy="14" rx="8" ry="4.5" fill="${C.blush}" opacity=".8"/><ellipse cx="30" cy="14" rx="8" ry="4.5" fill="${C.blush}" opacity=".8"/>` : ""}
    <path d="M-40 -8 Q0 -52 40 -8" stroke="${C.hoodie}" stroke-width="9" fill="none" stroke-linecap="round"/>
    <rect x="-52" y="-12" width="14" height="22" rx="6" fill="${C.hoodie}"/>
    <rect x="38" y="-12" width="14" height="22" rx="6" fill="${C.hoodie}"/>
    <rect x="-49" y="-6" width="8" height="4" rx="2" fill="${C.tech}" class="glow"/>
    <rect x="41" y="-6" width="8" height="4" rx="2" fill="${C.tech}" class="glow"/>
    <circle cx="0" cy="-40" r="4.5" fill="${C.tech}" class="glow"/>
  </g>
  ${state === "working" ? `<g class="arm arm-l" style="transform-box:fill-box;transform-origin:100% 15%"><g transform="translate(-30, 52) rotate(${armPose?.l ?? 0})"><rect x="-10" y="0" width="14" height="34" rx="7" fill="${C.hoodie}"/><circle cx="-3" cy="36" r="8" fill="${C.fur}"/></g></g>` : ""}
  <g class="arm arm-r" style="transform-box:fill-box;transform-origin:0% 15%"><g transform="translate(30, 52) rotate(${-(armPose?.r ?? 0)})"><rect x="-4" y="0" width="14" height="34" rx="7" fill="${C.hoodie}"/><circle cx="3" cy="36" r="8" fill="${C.fur}"/></g></g>
  ${props ?? ""}
</g>
</svg>
`;
}

for (const state of ["idle", "listening", "thinking", "working", "success", "error", "sleeping"]) {
  fs.writeFileSync(path.join(outDir, `${state}.svg`), animatedSvg(state), "utf-8");
  console.log(`已生成 animated/${state}.svg`);
}
console.log("完成。");
