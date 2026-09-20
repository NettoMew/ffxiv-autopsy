import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "./errors.ts";

export interface Config {
  readonly host: string;
  readonly apiKey: string;
}

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const KEY_PATTERN = /^[0-9a-f]{32}$/i;

/**
 * 读取配置。优先环境变量，其次 config.json。
 * API key 不进版本库，因此仓库里只放 config.example.json。
 */
export function loadConfig(): Config {
  const fromEnv = process.env["FFLOGS_API_KEY"]?.trim();
  const host = process.env["FFLOGS_HOST"]?.trim();

  if (fromEnv) {
    return { host: host || "cn.fflogs.com", apiKey: requireKey(fromEnv, "环境变量 FFLOGS_API_KEY") };
  }

  const path = resolve(ROOT, "config.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    fail(
      "找不到 config.json。",
      "把 config.example.json 复制成 config.json 并填入 v1 API key，或设置环境变量 FFLOGS_API_KEY。",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("config.json 不是合法的 JSON。");
  }

  if (typeof parsed !== "object" || parsed === null) fail("config.json 的内容必须是一个对象。");
  const record = parsed as Record<string, unknown>;
  const key = typeof record["apiKey"] === "string" ? record["apiKey"].trim() : "";
  const configuredHost = typeof record["host"] === "string" ? record["host"].trim() : "";

  return {
    host: host || configuredHost || "cn.fflogs.com",
    apiKey: requireKey(key, "config.json 的 apiKey"),
  };
}

function requireKey(key: string, source: string): string {
  if (!key) fail(`${source} 是空的。`);
  if (!KEY_PATTERN.test(key)) {
    fail(`${source} 看起来不是有效的 v1 API key。`, "v1 key 是 32 位十六进制字符串。");
  }
  return key;
}
