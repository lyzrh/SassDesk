/**
 * 桌面模式构建后处理：
 * 1. 复制渲染层 HTML（tsc 不复制非 TS 文件）
 * 2. 复制 preload.mjs（Electron ESM preload 要求 .mjs 扩展名，tsc 忽略 .mjs）
 * 3. 复制角色素材到 dist（保证发布形态自包含；开发模式 main.ts 也可直接读 assets/）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRenderer = path.join(root, "src", "desktop", "renderer");
const distRenderer = path.join(root, "dist", "desktop", "renderer");

fs.mkdirSync(distRenderer, { recursive: true });
for (const f of ["index.html", "input.html"]) {
  fs.copyFileSync(path.join(srcRenderer, f), path.join(distRenderer, f));
  console.log("copied", f);
}
fs.copyFileSync(path.join(root, "src", "desktop", "preload.mjs"), path.join(root, "dist", "desktop", "preload.mjs"));
console.log("copied preload.mjs");

// Cubism 2 core（Live2D 运行时）复制到渲染层可及位置
fs.mkdirSync(path.join(root, "dist", "desktop", "renderer", "vendor"), { recursive: true });
fs.copyFileSync(path.join(root, "src", "desktop", "renderer", "vendor", "live2d.min.js"), path.join(root, "dist", "desktop", "renderer", "vendor", "live2d.min.js"));
console.log("copied vendor/live2d.min.js (Cubism 2 core)");

// esbuild 打包 Live2D 引擎（pixi + pixi-live2d-display 内联为单文件，渲染层浏览器 ESM 可解析）
const { execSync } = await import("node:child_process");
execSync(
  'npx esbuild src/desktop/renderer/live2d-host.ts --bundle --format=esm --outfile=dist/desktop/renderer/l2d-bundle.js --log-level=warning',
  { stdio: "inherit" },
);
console.log("bundled l2d-bundle.js");

// Electron 主进程 ESM 入口必须是 .mjs（否则 import "electron" 命中 npm 包而非内置模块）
fs.copyFileSync(path.join(root, "dist", "desktop", "main.js"), path.join(root, "dist", "desktop", "main.mjs"));
console.log("copied main.js → main.mjs (electron ESM entry)");

const assetsSrc = path.join(root, "assets", "characters", "sass");
const assetsDist = path.join(root, "dist", "assets", "characters", "sass");
fs.cpSync(assetsSrc, assetsDist, { recursive: true });
console.log("copied character assets");
