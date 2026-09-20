#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, ROOT } from "./core/config.ts";
import { fail, UserError } from "./core/errors.ts";
import { style } from "./core/terminal.ts";
import { isMetric, WINDOW_LABELS, type Metric, type Report, type Window } from "./core/types.ts";
import { BASELINE_DIR, ensureBaseline } from "./domain/baseline.ts";
import { buildScoreboard, collect, neededPhases, type Aggregate, type Scoreboard } from "./domain/scoring.ts";
import { CACHE_DIR, clearCache } from "./net/cache.ts";
import { assertCurlAvailable } from "./net/http.ts";
import { FfLogsApi } from "./net/fflogs.ts";
import { StatisticsSource } from "./net/statistics.ts";
import { renderConsole } from "./render/console.ts";
import { renderCsv, renderSamplesCsv } from "./render/csv.ts";
import { renderHtml } from "./render/html.ts";
import { renderImages } from "./render/image.ts";
import { renderMarkdown } from "./render/markdown.ts";

const USAGE = `
验尸官 — 团灭之后把日志逐 P 剖开，看看是哪一段、哪个人出了问题

用法
  autopsy score <报告链接或代码> [选项]
  autopsy baseline --zone <id> --boss <id> [选项]
  autopsy cache clear

没有 npm link 过就写全：node src/main.ts score <报告链接或代码>

选项
  --metric <rdps|adps|ndps|cdps|hps>  评分口径，默认 rdps
  --fight <id>                        只评某一把，默认全部
  --phase <n>                         只评某个 P，默认全部
  --aggregate <median|best>           同一个 P 打了多把时怎么取值，默认 median
  --window <2|6|12>                   比对官方最近多少周的数据，默认 12
  --format <console,html,markdown,csv,image>  输出形式，可用逗号叠加，默认 console
  --out <目录>                        文件输出目录，默认 out
  --width <像素>                      导出图片的宽度，默认 1300
  --scale <倍数>                      导出图片的像素密度，默认 2
  --phases <n>                        baseline 命令最多抓到第几个 P
  --refresh                           忽略本地缓存重新抓取
  --no-color                          关闭颜色
`;

interface Options {
  readonly metric: Metric;
  readonly fightId: number | undefined;
  readonly phaseIndex: number | undefined;
  readonly aggregate: Aggregate;
  readonly window: Window;
  readonly formats: readonly string[];
  readonly out: string;
  readonly width: number;
  readonly scale: number;
  readonly phases: number | undefined;
  readonly refresh: boolean;
}

await main(process.argv.slice(2));

async function main(argv: readonly string[]): Promise<void> {
  try {
    const [command, ...rest] = argv;

    if (!command || command === "--help" || command === "-h" || command === "help") {
      process.stdout.write(`${USAGE.trimStart()}\n`);
      return;
    }

    switch (command) {
      case "score":
        await runScore(rest);
        return;
      case "baseline":
        await runBaseline(rest);
        return;
      case "cache":
        runCache(rest);
        return;
      default:
        fail(`未知命令：${command}`, "运行 autopsy --help 查看用法。");
    }
  } catch (error) {
    if (error instanceof UserError) {
      process.stderr.write(`${style.red("错误")} ${error.message}\n`);
      if (error.hint) process.stderr.write(`${style.gray(error.hint)}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

async function runScore(argv: readonly string[]): Promise<void> {
  const positional = argv.filter((item) => !item.startsWith("--"));
  const target = positional[0];
  if (!target) fail("请给出报告链接或代码。", "例如 autopsy score https://cn.fflogs.com/reports/xxxxxxxx");

  const options = parseOptions(argv);
  const config = loadConfig();
  const code = parseReportCode(target);
  await assertCurlAvailable();

  const api = new FfLogsApi(config, { refresh: options.refresh });
  const statistics = new StatisticsSource(config, { refresh: options.refresh });

  try {
    await score(api, statistics, config.host, code, options);
  } finally {
    api.close();
    statistics.close();
  }
}

async function score(
  api: FfLogsApi,
  statistics: StatisticsSource,
  host: string,
  code: string,
  options: Options,
): Promise<void> {
  note(`读取报告 ${code}`);
  const full = await api.report(code);
  const report = focusOnSingleEncounter(full, options.fightId);
  const encounterId = report.fights[0]?.encounterId ?? 0;

  const phases = neededPhases(report, { fightId: options.fightId, phaseIndex: options.phaseIndex });
  if (phases.length === 0) {
    fail("这份报告里没有一个 P 是完整打完的，没法评分。", "被团灭打断的 P 和官方通关数据没法比。");
  }

  note(`比对官方数据：版本分区自动识别，最近 ${WINDOW_LABELS[options.window]}，共 ${phases.length} 个 P`);
  const baseline = await ensureBaseline(
    statistics,
    { zoneId: report.zoneId, encounterId, metric: options.metric, window: options.window },
    phases,
    (phase) => note(`  取 P${phase} 的官方数据`),
  );

  const samples = await collect(api, report, {
    metric: options.metric,
    fightId: options.fightId,
    phaseIndex: options.phaseIndex,
    onProgress: (done, total, label) => progress(done, total, label),
  });

  const board = buildScoreboard(report, baseline, samples, {
    metric: options.metric,
    aggregate: options.aggregate,
  });

  const outputs = new Set(options.formats);
  if (outputs.has("console")) process.stdout.write(renderConsole(board, host));

  if (outputs.has("html") || outputs.has("markdown") || outputs.has("csv") || outputs.has("image")) {
    const dir = resolve(ROOT, options.out, runFolder(board));
    mkdirSync(dir, { recursive: true });

    if (outputs.has("html")) emit(join(dir, "报告.html"), renderHtml(board, host));
    if (outputs.has("markdown")) emit(join(dir, "报告.md"), renderMarkdown(board, host));
    if (outputs.has("csv")) {
      emit(join(dir, "汇总.csv"), renderCsv(board));
      emit(join(dir, "明细.csv"), renderSamplesCsv(board));
    }
    if (outputs.has("image")) {
      const files = await renderImages(
        board,
        host,
        dir,
        { width: options.width, scale: options.scale },
        (done, total, title) => progress(done, total, `渲染 ${title}`),
      );
      note(`写出 ${files.length} 张图片`);
    }

    note(`输出目录 ${dir}`);
  }

  reportBudget(api);
}

async function runBaseline(argv: readonly string[]): Promise<void> {
  const options = parseOptions(argv);
  const zoneId = Number(valueOf(argv, "--zone"));
  const encounterId = Number(valueOf(argv, "--boss"));

  if (!Number.isFinite(zoneId) || !Number.isFinite(encounterId)) {
    fail("baseline 命令需要 --zone 与 --boss。", "副本与 boss 的编号可以在统计页地址里看到。");
  }

  const config = loadConfig();
  await assertCurlAvailable();
  const statistics = new StatisticsSource(config, { refresh: options.refresh });
  const limit = options.phases ?? 12;
  const wanted = Array.from({ length: limit + 1 }, (_, index) => index);

  note(`为副本 ${zoneId} 的 boss ${encounterId} 建立 ${options.metric} 基准`);

  try {
    const baseline = await ensureBaseline(
      statistics,
      { zoneId, encounterId, metric: options.metric, window: options.window },
      wanted,
      (phase) => note(`  取 P${phase}`),
    );

    const summary = Object.entries(baseline.phases)
      .map(([phase, curves]) => `P${phase}: ${Object.keys(curves).length} 个职业`)
      .join("\n  ");

    process.stdout.write(`\n基准已写入 ${BASELINE_DIR}\n  ${summary}\n\n`);
  } finally {
    statistics.close();
  }
}

function runCache(argv: readonly string[]): void {
  if (argv[0] !== "clear") fail("cache 命令目前只支持 clear。");
  clearCache();
  process.stdout.write(`已清空 ${CACHE_DIR}\n`);
}

/**
 * 一份报告里可能混着多个 boss。评分只在单个 boss 内部才有意义，
 * 因此默认挑记录最多的那个，并在必要时说明。
 */
function focusOnSingleEncounter(report: Report, fightId: number | undefined): Report {
  if (fightId !== undefined) {
    const fight = report.fights.find((item) => item.id === fightId);
    if (!fight) fail(`报告里没有第 ${fightId} 把。`);
    return { ...report, fights: [fight] };
  }

  const counts = new Map<number, number>();
  for (const fight of report.fights) counts.set(fight.encounterId, (counts.get(fight.encounterId) ?? 0) + 1);

  const [chosen] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [0];
  if (counts.size > 1) note(`报告含 ${counts.size} 个 boss，取记录最多的 ${chosen}`);

  return { ...report, fights: report.fights.filter((fight) => fight.encounterId === chosen) };
}

function parseOptions(argv: readonly string[]): Options {
  const metric = valueOf(argv, "--metric") ?? "rdps";
  if (!isMetric(metric)) fail(`不认识的口径：${metric}`, "可选 rdps、adps、ndps、cdps、hps。");

  const aggregate = valueOf(argv, "--aggregate") ?? "median";
  if (aggregate !== "median" && aggregate !== "best") fail(`不认识的取值方式：${aggregate}`);

  const weeks = Number(valueOf(argv, "--window") ?? 12);
  const window: Window =
    weeks === 2 ? 14 : weeks === 6 ? 42 : weeks === 12 ? 84 : fail(`窗口只支持 2、6、12 周，收到 ${weeks}`);

  const formats = (valueOf(argv, "--format") ?? "console")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  for (const format of formats) {
    if (!["console", "html", "markdown", "csv", "image"].includes(format)) fail(`不认识的输出形式：${format}`);
  }

  const width = numberOf(argv, "--width") ?? 1300;
  const scale = numberOf(argv, "--scale") ?? 2;
  if (width < 600 || width > 4000) fail(`图片宽度需在 600 到 4000 之间，收到 ${width}`);
  if (scale < 1 || scale > 4) fail(`像素密度需在 1 到 4 之间，收到 ${scale}`);

  return {
    metric,
    aggregate,
    window,
    formats,
    width,
    scale,
    fightId: numberOf(argv, "--fight"),
    phaseIndex: numberOf(argv, "--phase"),
    phases: numberOf(argv, "--phases"),
    out: valueOf(argv, "--out") ?? "out",
    refresh: argv.includes("--refresh"),
  };
}

function valueOf(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`${flag} 缺少取值。`);
  return value;
}

function numberOf(argv: readonly string[], flag: string): number | undefined {
  const raw = valueOf(argv, flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`${flag} 需要一个数字，收到 ${raw}`);
  return value;
}

/** 接受完整链接、带锚点的链接或裸代码。 */
function parseReportCode(input: string): string {
  const fromUrl = /reports\/([A-Za-z0-9]+)/.exec(input)?.[1];
  const code = fromUrl ?? input.trim();
  if (!/^[A-Za-z0-9]{8,}$/.test(code)) fail(`看不出报告代码：${input}`);
  return code;
}

/**
 * 每次运行单独一个文件夹，按日志的时间命名。
 *
 * 一晚开荒下来会跑好几份报告，全堆在一个目录里靠文件名区分很快就乱了。
 * 用日志自身的时间而不是运行时间，同一份日志重跑会覆盖旧结果，正是想要的。
 */
function runFolder(board: Scoreboard): string {
  const at = board.report.start > 0 ? new Date(board.report.start) : new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
  return `${stamp}-${board.report.code}-${board.metric}`;
}

function emit(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  note(`写出 ${path}`);
}

function note(message: string): void {
  process.stderr.write(`${style.gray(message)}\n`);
}

function progress(done: number, total: number, label: string): void {
  if (!process.stderr.isTTY) return;
  if (done >= total) {
    process.stderr.write("\r\u001B[2K");
    return;
  }
  process.stderr.write(`\r\u001B[2K${style.gray(`取各 P 数据 ${done}/${total}  ${label}`)}`);
}

function reportBudget(api: FfLogsApi): void {
  const { limit, remaining } = api.budget;
  if (limit === null || remaining === null) return;
  note(`接口配额 ${remaining}/${limit}`);
}
