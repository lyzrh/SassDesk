import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * 桌宠桥接：CLI ↔ 桌宠进程。
 * - 桌宠启动时把 { port, pid } 写入 <configDir>/pet.json（固定端口 22345，被占用回退随机）
 * - CLI 通过 POST /pet/state 把角色状态（idle/thinking/working/...）实时同步给桌宠
 * - /pet start 可由 CLI 直接拉起桌宠进程
 */

export interface PetInfo {
  port: number;
  pid: number;
  startedAt: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 读取桌宠发现文件 */
export function readPetInfo(configDir: string): PetInfo | null {
  try {
    const p = path.join(configDir, "pet.json");
    if (!fs.existsSync(p)) return null;
    const info = JSON.parse(fs.readFileSync(p, "utf-8")) as PetInfo;
    if (!info.port) return null;
    return info;
  } catch {
    return null;
  }
}

/** 桌宠是否在线（HTTP 探测） */
export async function isPetRunning(configDir: string): Promise<boolean> {
  const info = readPetInfo(configDir);
  if (!info) return false;
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: info.port, path: "/ping", method: "GET", timeout: 1500 },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/** 推送角色状态到桌宠（桌宠未运行则静默失败） */
export function pushPetState(configDir: string, state: string, reason?: string): Promise<boolean> {
  const info = readPetInfo(configDir);
  if (!info) return Promise.resolve(false);
  return new Promise((resolve) => {
    const body = JSON.stringify({ state, reason });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: info.port,
        path: "/pet/state",
        method: "POST",
        timeout: 2000,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end(body);
  });
}

/** 由 CLI 启动桌宠（detached，CLI 退出不影响桌宠） */
export async function startPet(configDir: string): Promise<{ ok: boolean; message: string }> {
  if (await isPetRunning(configDir)) return { ok: true, message: "桌宠已在运行" };
  try {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const electronBin = path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
    const entry = path.join(projectRoot, "dist", "desktop", "main.mjs");
    if (!fs.existsSync(electronBin) || !fs.existsSync(entry)) {
      return { ok: false, message: "未找到桌宠产物，请先执行 npm run build && npm run desktop:build" };
    }
    const child = spawn(electronBin, [entry], { detached: true, stdio: "ignore" });
    child.unref();
    // 等待 pet.json 出现且服务在线
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await sleep(500);
      if (await isPetRunning(configDir)) {
        const info = readPetInfo(configDir);
        return { ok: true, message: `桌宠已启动（端口 ${info?.port ?? "?"}）` };
      }
    }
    return { ok: false, message: "桌宠启动超时，请查看 logs/desktop-*.log" };
  } catch (e) {
    return { ok: false, message: `桌宠启动失败：${(e as Error).message}` };
  }
}
