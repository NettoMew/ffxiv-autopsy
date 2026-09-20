import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { UserError } from "../core/errors.ts";

const run = promisify(execFile);

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

export interface RequestOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly method?: "GET" | "POST";
  readonly body?: string;
  /** 默认跟随重定向；人机确认握手需要自己看 302，故可关闭。 */
  readonly followRedirects?: boolean;
}

/**
 * 走系统 curl 的 HTTP 客户端。
 *
 * 这里不用 Node 内置的 fetch 或 http2，原因是实测出来的：
 * 站点前置的防护会按 TLS 握手指纹判断来路，Node 自带的 OpenSSL 指纹在统计页
 * 那条路径上一律被挡，而系统 curl 的指纹可以正常通过。curl 是操作系统自带的
 * 工具而非第三方包，项目因此仍然没有任何 npm 依赖。
 *
 * 会话与 Cookie 交给 curl 自己的 cookie jar 维持，一次运行用一个临时文件。
 *
 * 节流不是为了绕过什么：一次完整运行只有几十个请求，慢一点不影响体验，
 * 却能让远端几乎察觉不到本程序的存在。
 */
export class HttpClient {
  readonly #dir: string;
  readonly #jar: string;
  readonly #minInterval: number;
  readonly #timeout: number;
  readonly #retries: number;
  #nextAllowed = 0;

  constructor(options: { minIntervalMs?: number; timeoutMs?: number; retries?: number } = {}) {
    this.#dir = mkdtempSync(join(tmpdir(), "fflogs-score-"));
    this.#jar = join(this.#dir, "cookies");
    this.#minInterval = options.minIntervalMs ?? 250;
    this.#timeout = options.timeoutMs ?? 30_000;
    this.#retries = options.retries ?? 3;
  }

  async request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      if (attempt > 0) await delay(500 * 2 ** (attempt - 1));
      await this.#pace();

      try {
        const response = await this.#send(url, options);
        if (response.status >= 500 || response.status === 429) {
          lastError = new UserError(`${url} 返回 ${response.status}`);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
      }
    }

    throw new UserError(
      `请求失败：${url}`,
      lastError instanceof Error ? lastError.message : "网络不可达或远端持续返回错误。",
    );
  }

  /** 清理临时会话文件。 */
  close(): void {
    rmSync(this.#dir, { recursive: true, force: true });
  }

  async #send(url: string, options: RequestOptions): Promise<HttpResponse> {
    const headerFile = join(this.#dir, "headers");
    const bodyFile = join(this.#dir, "body");

    const args = [
      "--silent",
      "--show-error",
      "--compressed",
      "--max-time",
      String(Math.ceil(this.#timeout / 1000)),
      "--cookie",
      this.#jar,
      "--cookie-jar",
      this.#jar,
      "--dump-header",
      headerFile,
      "--output",
      bodyFile,
      "--user-agent",
      USER_AGENT,
    ];

    if (options.followRedirects !== false) args.push("--location");

    const headers: Record<string, string> = {
      "Accept-Language": "zh-CN,zh;q=0.9",
      ...options.headers,
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";

    for (const [name, value] of Object.entries(headers)) {
      args.push("--header", `${canonical(name)}: ${value}`);
    }

    if (options.body !== undefined) args.push("--data-binary", options.body);
    else if (options.method === "POST") args.push("--request", "POST");

    args.push(url);

    try {
      await run(curlPath(), args, { maxBuffer: 1 << 24, windowsHide: true });
    } catch (error) {
      throw new UserError(`curl 执行失败：${url}`, error instanceof Error ? error.message : undefined);
    }

    const received = parseHeaders(read(headerFile));
    return { status: received.status, headers: received.headers, body: read(bodyFile) };
  }

  async #pace(): Promise<void> {
    const wait = this.#nextAllowed - Date.now();
    if (wait > 0) await delay(wait);
    this.#nextAllowed = Date.now() + this.#minInterval;
  }
}

let resolved: string | null = null;

/** 只在第一次调用时确认 curl 存在，失败时给出可操作的提示。 */
function curlPath(): string {
  if (resolved) return resolved;
  resolved = process.env["FFLOGS_CURL"]?.trim() || "curl";
  return resolved;
}

export async function assertCurlAvailable(): Promise<void> {
  try {
    await run(curlPath(), ["--version"], { windowsHide: true });
  } catch {
    throw new UserError(
      "找不到可执行的 curl。",
      "Windows 10 1803 以上、macOS 与主流 Linux 都自带 curl；如果装在别处，可用环境变量 FFLOGS_CURL 指定完整路径。",
    );
  }
}

/**
 * 把请求头名规范成浏览器惯用的写法。
 *
 * 这不是洁癖：实测中同一个请求，头名写成小写 accept 会被防护层判成机器人并返回 403，
 * 写成 Accept 则一切正常。HTTP 头名本身大小写不敏感，但对面在看它。
 */
function canonical(name: string): string {
  return name
    .split("-")
    .map((part) => (part ? part[0]?.toUpperCase() + part.slice(1).toLowerCase() : part))
    .join("-");
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** curl 跟随重定向时会依次转储每一段响应头，这里只取最后一段。 */
function parseHeaders(dump: string): { status: number; headers: Headers } {
  const blocks = dump
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  const last = blocks[blocks.length - 1] ?? "";
  const lines = last.split(/\r?\n/);
  const status = Number(/^HTTP\/[\d.]+\s+(\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0);
  const headers = new Headers();

  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    try {
      headers.append(name, value);
    } catch {
      // 忽略不合法的响应头名。
    }
  }

  return { status, headers };
}
