/**
 * 生成 Sass 角色 7 状态的占位 SVG（几何 Q 版狐狸，透明底，矢量缩放清晰）。
 * 用途：正式 PNG 缺失时的回退素材（docs/character-assets.md）。
 * 运行：node scripts/gen-placeholder-svgs.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const charDir = path.join(root, "assets", "characters", "sass");

/** 配色（与 manifest.visualSpec.palette 一致） */
const C = {
  fur: "#8DA3B8",     // 灰蓝主色
  furDark: "#5B7A99", // 深灰蓝（耳背/尾根）
  white: "#FFFFFF",   // 脸颊/胸口/尾尖
  hoodie: "#2B3440",  // 深色连帽衫
  hoodieLight: "#3A4756",
  tech: "#59C2FF",    // 科技蓝点缀
  eye: "#22303C",
  blush: "#F2A9B8",
};

/**
 * @param {object} o 状态差异参数
 * @returns {string} SVG 文本
 */
function foxSvg(o) {
  const {
    label = "占位",
    earTilt = 0,          // 耳朵额外角度
    earDroop = 0,         // 耳朵下垂（error）
    headTilt = 0,         // 头部歪斜（thinking）
    eyes = "open",        // open | happy | closed | down | wide
    mouth = "smile",      // smile | small | open | flat
    bodyPose = "stand",   // stand | lie | sit
    tail = "down",        // down | up | curl
    props = [],           // "laptop" | "stars" | "headphoneGlow"
    blush = false,
  } = o;

  const eyeShapes = {
    open: `<circle cx="98" cy="96" r="9" fill="${C.eye}"/><circle cx="101" cy="93" r="3" fill="#FFF"/><circle cx="142" cy="96" r="9" fill="${C.eye}"/><circle cx="145" cy="93" r="3" fill="#FFF"/>`,
    wide: `<circle cx="98" cy="96" r="11" fill="${C.eye}"/><circle cx="101" cy="92" r="4" fill="#FFF"/><circle cx="142" cy="96" r="11" fill="${C.eye}"/><circle cx="145" cy="92" r="4" fill="#FFF"/>`,
    happy: `<path d="M90 96 Q98 86 106 96" stroke="${C.eye}" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M134 96 Q142 86 150 96" stroke="${C.eye}" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    closed: `<path d="M90 96 L106 96" stroke="${C.eye}" stroke-width="5" stroke-linecap="round"/><path d="M134 96 L150 96" stroke="${C.eye}" stroke-width="5" stroke-linecap="round"/>`,
    down: `<path d="M92 98 Q98 102 106 98" stroke="${C.eye}" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M136 98 Q142 102 150 98" stroke="${C.eye}" stroke-width="5" fill="none" stroke-linecap="round"/>`,
  };
  const mouthShapes = {
    smile: `<path d="M114 118 Q120 124 126 118" stroke="${C.eye}" stroke-width="4" fill="none" stroke-linecap="round"/>`,
    small: `<path d="M116 120 L124 120" stroke="${C.eye}" stroke-width="4" stroke-linecap="round"/>`,
    open: `<ellipse cx="120" cy="121" rx="7" ry="6" fill="${C.eye}"/><ellipse cx="120" cy="123" rx="4" ry="3" fill="${C.blush}"/>`,
    flat: `<path d="M114 120 Q120 117 126 120" stroke="${C.eye}" stroke-width="4" fill="none" stroke-linecap="round"/>`,
  };

  // 耳朵（带下垂/倾斜变换）
  const ear = (side) => {
    const mirror = side === "r" ? "translate(240,0) scale(-1,1)" : "";
    const droop = earDroop ? `rotate(${earDroop} 78 76)` : "";
    return `<g transform="${mirror} ${droop}">
      <path d="M60 74 L70 26 L96 60 Z" fill="${C.furDark}"/>
      <path d="M66 66 L72 38 L88 58 Z" fill="#C7D3DE"/>
    </g>`;
  };

  // 尾巴
  const tailShape = {
    down: `<path d="M176 178 Q224 186 214 148 Q208 128 186 134 Q204 150 176 160 Z" fill="${C.fur}"/><path d="M206 136 Q216 142 212 154 Q220 142 206 136 Z" fill="${C.white}"/>`,
    up: `<path d="M178 168 Q232 168 220 116 Q214 96 194 104 Q212 118 190 140 Q182 152 178 168 Z" fill="${C.fur}"/><path d="M212 102 Q224 110 218 124 Q228 112 212 102 Z" fill="${C.white}"/>`,
    curl: `<path d="M178 180 Q226 188 222 142 Q218 122 196 128 Q212 142 188 158 Z" fill="${C.fur}"/><circle cx="212" cy="132" r="10" fill="${C.white}"/>`,
  }[tail];

  // 身体
  const body = bodyPose === "lie"
    ? `<ellipse cx="120" cy="196" rx="62" ry="26" fill="${C.hoodie}"/><ellipse cx="120" cy="192" rx="48" ry="18" fill="${C.hoodieLight}"/><ellipse cx="76" cy="206" rx="14" ry="8" fill="${C.fur}"/><ellipse cx="164" cy="206" rx="14" ry="8" fill="${C.fur}"/>`
    : `<rect x="86" y="140" width="68" height="64" rx="26" fill="${C.hoodie}"/><path d="M96 150 Q120 132 144 150 L144 162 Q120 146 96 162 Z" fill="${C.hoodieLight}"/><rect x="104" y="168" width="32" height="30" rx="12" fill="${C.white}"/><rect x="92" y="196" width="18" height="10" rx="5" fill="${C.fur}"/><rect x="130" y="196" width="18" height="10" rx="5" fill="${C.fur}"/>`;

  // 附加元素
  const extras = [];
  if (props.includes("laptop")) {
    extras.push(`<g><rect x="88" y="168" width="64" height="8" rx="2" fill="#4A5568"/><rect x="92" y="146" width="56" height="24" rx="3" fill="#5B6B7E"/><rect x="95" y="149" width="50" height="18" rx="2" fill="${C.tech}" opacity="0.35"/></g>`);
  }
  if (props.includes("stars")) {
    for (const [x, y, r] of [[52, 70, 6], [186, 60, 7], [198, 100, 5], [44, 120, 4]]) {
      extras.push(`<path d="M${x} ${y - r} L${x + r * 0.3} ${y - r * 0.3} L${x + r} ${y} L${x + r * 0.3} ${y + r * 0.3} L${x} ${y + r} L${x - r * 0.3} ${y + r * 0.3} L${x - r} ${y} L${x - r * 0.3} ${y - r * 0.3} Z" fill="#FFD97A"/>`);
    }
  }
  if (props.includes("headphoneGlow")) {
    extras.push(`<circle cx="70" cy="104" r="4" fill="${C.tech}"><animate attributeName="opacity" values="1;0.3;1" dur="1.6s" repeatCount="indefinite"/></circle>`);
  }

  const headTransform = headTilt ? `rotate(${headTilt} 120 100)` : "";
  const headGroup = `<g transform="${headTransform}">
    ${ear("l")}${ear("r")}
    <circle cx="120" cy="100" r="46" fill="${C.fur}"/>
    <path d="M120 132 Q86 128 80 104 Q96 130 120 130 Q144 130 160 104 Q154 128 120 132 Z" fill="${C.white}"/>
    <path d="M120 128 Q104 142 120 148 Q136 142 120 128 Z" fill="${C.white}"/>
    ${eyeShapes[eyes]}
    ${mouthShapes[mouth]}
    <path d="M116 110 L124 110 L120 115 Z" fill="${C.eye}"/>
    ${blush ? `<ellipse cx="86" cy="112" rx="9" ry="5" fill="${C.blush}" opacity="0.75"/><ellipse cx="154" cy="112" rx="9" ry="5" fill="${C.blush}" opacity="0.75"/>` : ""}
    <path d="M74 104 Q70 100 74 96" stroke="${C.hoodie}" stroke-width="7" fill="none" stroke-linecap="round"/>
    <path d="M166 104 Q170 100 166 96" stroke="${C.hoodie}" stroke-width="7" fill="none" stroke-linecap="round"/>
    <path d="M74 100 Q120 58 166 100" stroke="${C.hoodie}" stroke-width="8" fill="none" stroke-linecap="round"/>
    <circle cx="120" cy="66" r="5" fill="${C.tech}"><animate attributeName="opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite"/></circle>
    ${props.includes("headphoneGlow") ? `<circle cx="72" cy="102" r="3.5" fill="${C.tech}"/>` : ""}
  </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240">
  <!-- Sass placeholder (占位素材): ${label} -->
  ${tail}
  ${body}
  ${headGroup}
  ${extras.join("\n  ")}
</svg>`;
}

/** 七状态的占位差异参数 */
const STATES = {
  idle: { label: "IDLE 待机", eyes: "open", mouth: "smile", tail: "down" },
  listening: { label: "LISTENING 聆听", eyes: "wide", mouth: "small", tail: "curl", props: ["headphoneGlow"] },
  thinking: { label: "THINKING 思考", headTilt: 8, eyes: "down", mouth: "flat", tail: "curl" },
  working: { label: "WORKING 工作", bodyPose: "sit", eyes: "down", mouth: "small", tail: "down", props: ["laptop"] },
  success: { label: "SUCCESS 成功", eyes: "happy", mouth: "open", tail: "up", props: ["stars"] },
  error: { label: "ERROR 出错", earDroop: 26, eyes: "down", mouth: "flat", tail: "down", blush: true },
  sleeping: { label: "SLEEPING 休息", bodyPose: "lie", eyes: "closed", mouth: "small", tail: "curl" },
};

for (const [state, opts] of Object.entries(STATES)) {
  const dir = path.join(charDir, state);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "placeholder.svg"), foxSvg(opts) + "\n", "utf-8");
  console.log(`已生成 ${state}/placeholder.svg`);
}
fs.writeFileSync(path.join(charDir, "placeholder.svg"), foxSvg({ label: "通用回退", eyes: "open", mouth: "smile" }) + "\n", "utf-8");
console.log("已生成 manifest.fallback placeholder.svg");
