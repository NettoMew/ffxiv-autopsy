import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT } from "../core/config.ts";

const DIR = resolve(ROOT, "data", "cache");

/**
 * 内容寻址的磁盘缓存。
 *
 * 每一次远端调用都先过这里，所以同一份报告、同一份基准重跑一次也不会再发请求。
 * 这是整个程序把请求数压在两位数的直接原因。
 */
export class Cache {
  readonly #namespace: string;
  readonly #enabled: boolean;

  constructor(namespace: string, enabled = true) {
    this.#namespace = namespace;
    this.#enabled = enabled;
  }

  get(key: string): string | null {
    if (!this.#enabled) return null;
    try {
      return readFileSync(this.#path(key), "utf8");
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    if (!this.#enabled) return;
    const path = this.#path(key);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, value, "utf8");
  }

  #path(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return join(DIR, this.#namespace, digest.slice(0, 2), `${digest.slice(2)}.txt`);
  }
}

export function clearCache(): void {
  rmSync(DIR, { recursive: true, force: true });
}

export const CACHE_DIR = DIR;
