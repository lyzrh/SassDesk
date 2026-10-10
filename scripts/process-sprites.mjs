/**
 * 处理 AI 生成的角色原始图 → 桌宠标准素材：
 * 1. 预裁四边 2%（去角落水印）
 * 2. 按 alpha 包围盒裁剪内容
 * 3. 等比缩放（盒式滤波）到 220px 内，居中贴到 240×240 透明画布
 * 4. 透明度校验（四角必须透明）
 * 5. 重命名 <state>.png，删除原始文件
 * 运行：node scripts/process-sprites.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const charDir = path.join(root, "assets", "characters", "sass");
const TARGET = 240;
const MAX_CONTENT = 222; // 内容最长边（留边距）

const STATES = ["idle", "listening", "thinking", "working", "success", "error", "sleeping"];

/** 找状态目录里的原始生成图（Based_*.png 或 *-raw.png） */
function findRaw(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".png") && !f.match(new RegExp(`^(${STATES.join("|")})\\.png$`)));
}

function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

/** 预裁 + alpha 包围盒 */
function contentBBox(png) {
  const edgeCut = Math.floor(png.width * 0.02);
  const x0 = edgeCut, y0 = edgeCut, x1 = png.width - edgeCut, y1 = png.height - edgeCut;
  let minX = x1, minY = y1, maxX = x0, maxY = y0, found = false;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const a = png.data[(y * png.width + x) * 4 + 3];
      if (a > 12) {
        found = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!found) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** 盒式滤波缩放 */
function resizeBox(png, bbox, targetW, targetH) {
  const out = new PNG({ width: targetW, height: targetH });
  const sx = bbox.w / targetW, sy = bbox.h / targetH;
  for (let y = 0; y < targetH; y++) {
    const fy0 = bbox.y + Math.floor(y * sy), fy1 = bbox.y + Math.max(fy0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < targetW; x++) {
      const fx0 = bbox.x + Math.floor(x * sx), fx1 = bbox.x + Math.max(fx0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let fy = fy0; fy < fy1 && fy < bbox.y + bbox.h; fy++) {
        for (let fx = fx0; fx < fx1 && fx < bbox.x + bbox.w; fx++) {
          const i = (fy * png.width + fx) * 4;
          const pa = png.data[i + 3] / 255;
          r += png.data[i] * pa; g += png.data[i + 1] * pa; b += png.data[i + 2] * pa; a += png.data[i + 3];
          n++;
        }
      }
      const o = (y * targetW + x) * 4;
      const alpha = a / n;
      if (alpha > 0.5) {
        out.data[o] = Math.round(r / (a / 255) / (n ? 1 : 1));
        out.data[o] = Math.round(r / n / (alpha / 255));
        out.data[o + 1] = Math.round(g / n / (alpha / 255));
        out.data[o + 2] = Math.round(b / n / (alpha / 255));
        out.data[o + 3] = Math.round(alpha);
      }
    }
  }
  return out;
}

const report = [];
for (const state of STATES) {
  const dir = path.join(charDir, state);
  const raws = findRaw(dir);
  if (raws.length === 0) {
    report.push(`${state}: 无原始图（保留占位 SVG）`);
    continue;
  }
  const rawPath = path.join(dir, raws[0]);
  const png = readPng(rawPath);
  const bbox = contentBBox(png);
  if (!bbox) {
    report.push(`${state}: 内容全透明？跳过（保留占位）`);
    continue;
  }
  // 等比缩放
  const scale = Math.min(MAX_CONTENT / bbox.w, MAX_CONTENT / bbox.h, 1);
  const tw = Math.max(1, Math.round(bbox.w * scale));
  const th = Math.max(1, Math.round(bbox.h * scale));
  const resized = resizeBox(png, bbox, tw, th);
  // 居中画布
  const canvas = new PNG({ width: TARGET, height: TARGET });
  PNG.bitblt(resized, canvas, 0, 0, tw, th, Math.floor((TARGET - tw) / 2), Math.floor((TARGET - th) / 2));
  // 透明校验（四角）
  const cornerAlpha = (x, y) => canvas.data[(y * TARGET + x) * 4 + 3];
  const cornersOk = [cornerAlpha(0, 0), cornerAlpha(TARGET - 1, 0), cornerAlpha(0, TARGET - 1), cornerAlpha(TARGET - 1, TARGET - 1)].every((a) => a === 0);
  // 保存
  fs.writeFileSync(path.join(dir, `${state}.png`), PNG.sync.write(canvas));
  fs.unlinkSync(rawPath);
  report.push(`${state}: ✓ ${bbox.w}x${bbox.h} → ${tw}x${th} @240x240${cornersOk ? "（四角透明 ✓）" : "（⚠ 四角非透明）"}`);
}
console.log(report.join("\n"));
