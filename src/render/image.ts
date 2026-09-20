import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { UserError } from "../core/errors.ts";
import type { Scoreboard } from "../domain/scoring.ts";
import { renderHtml } from "./html.ts";

const run = promisify(execFile);

/**
 * 把报告导出成一张图。
 *
 * 借系统上已有的 Chrome 或 Edge 无头渲染，不引入任何打包好的浏览器——
 * 那类依赖动辄几百兆，为了一张图不值得。找不到浏览器时会明确说清楚，
 * 而不是悄悄少生成一个文件。
 *
 * 导出的内容与网页一致，但各阶段明细一律摊开：网页里那几块是折叠的，
 * 点一下就展开，静态图片点不动，收着等于没有。
 */

export interface ImageOptions {
  readonly width: number;
  /** 像素密度。文字密集的图放大一倍在聊天软件里明显更清楚。 */
  readonly scale: number;
}

/** 页面渲染完后把自己的高度写进 DOM，供下一步按内容裁切窗口。 */
const MEASURE = `<script>document.documentElement.setAttribute("data-height",String(document.body.scrollHeight))</script>`;

export async function renderImage(
  board: Scoreboard,
  host: string,
  target: string,
  options: ImageOptions,
): Promise<void> {
  const browser = findBrowser();
  const workspace = mkdtempSync(join(tmpdir(), "fflogs-shot-"));
  const page = join(workspace, "page.html");
  const profile = join(workspace, "profile");

  try {
    writeFileSync(page, renderHtml(board, host, { forImage: true }).replace("</body>", `${MEASURE}</body>`), "utf8");

    const url = fileUrl(page);
    const base = [
      "--headless",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      `--user-data-dir=${profile}`,
      "--virtual-time-budget=5000",
      `--force-device-scale-factor=${options.scale}`,
    ];

    const dom = await run(browser, [...base, `--window-size=${options.width},200`, "--dump-dom", url], {
      maxBuffer: 1 << 26,
      windowsHide: true,
      timeout: 90_000,
    });

    const height = Number(/data-height="(\d+)"/.exec(dom.stdout)?.[1]);
    if (!Number.isFinite(height) || height <= 0) {
      throw new UserError("无法测出页面高度。", "浏览器可能拒绝执行页面脚本。");
    }

    await run(browser, [...base, `--window-size=${options.width},${height}`, `--screenshot=${target}`, url], {
      maxBuffer: 1 << 24,
      windowsHide: true,
      timeout: 90_000,
    });

    if (!existsSync(target)) throw new UserError("浏览器没有写出图片。", `目标：${target}`);
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError("导出图片失败。", error instanceof Error ? error.message : undefined);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function fileUrl(path: string): string {
  return `file:///${path.replace(/\\/g, "/")}`;
}

const WINDOWS_CANDIDATES = [
  "Google\\Chrome\\Application\\chrome.exe",
  "Microsoft\\Edge\\Application\\msedge.exe",
  "Chromium\\Application\\chrome.exe",
];

const MAC_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

const LINUX_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
  "/snap/bin/chromium",
];

/** 找一个能用的 Chromium 系浏览器。 */
function findBrowser(): string {
  const configured = process.env["FFLOGS_BROWSER"]?.trim();
  if (configured) {
    if (!existsSync(configured)) {
      throw new UserError(`FFLOGS_BROWSER 指向的文件不存在：${configured}`);
    }
    return configured;
  }

  const candidates =
    process.platform === "win32"
      ? WINDOWS_CANDIDATES.flatMap((relative) =>
          [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env["LOCALAPPDATA"]]
            .filter((root): root is string => Boolean(root))
            .map((root) => join(root, relative)),
        )
      : process.platform === "darwin"
        ? MAC_CANDIDATES
        : LINUX_CANDIDATES;

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new UserError(
    "找不到可用于导出图片的浏览器。",
    "需要 Chrome、Edge 或 Chromium 之一；装在非默认位置时可用环境变量 FFLOGS_BROWSER 指定完整路径。",
  );
}
