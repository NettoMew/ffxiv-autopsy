import type { JobKey, WindowChoice } from "../core/types.ts";

/**
 * 统计页的解析。
 *
 * 这里全是纯函数：进来一段 HTML，出去一组数字，不碰网络也不碰磁盘，
 * 因此页面一旦改版，能靠测试立刻发现是哪一处锚点失效。
 *
 * 页面把每个职业的数据内联在图表脚本里，形如
 *
 *   var series = { name: "召唤师", data: [] };
 *   series.color = setLineColorForActorFromType("Summoner");
 *
 * 之后紧跟该职业的数值。以这两行为界把脚本切块，职业标识与数值就不会错位。
 */

export interface ZoneDefaults {
  readonly partition: number;
  readonly difficulty: number;
  readonly size: number;
  /** 页面自己的默认取样窗口。 */
  readonly sample: number;
  /** 这个副本提供的全部取样窗口，按天数降序。 */
  readonly samples: readonly WindowChoice[];
}

/** 1000 号数据集一次给出的五个分位、真最高值与记录数。 */
export interface Spread {
  readonly label: string;
  readonly q25: number;
  readonly q50: number;
  readonly q75: number;
  readonly q95: number;
  readonly q99: number;
  readonly max: number;
  readonly sampleSize: number;
}

const SERIES =
  /var series = \{ name: "([^"]+)", data: \[\] \};\s*series\.color = setLineColorForActorFromType\("([A-Za-z]+)"\);/g;

const BAR_VALUE = /singleColumnSeries\.data\.push\(\{ name: series\.name, color: seriesColor, y: ([\d.]+) \}\)/;

const TABLE_ROW =
  /<td nowrap class="([A-Za-z]+)">[\s\S]*?class="main-table-number primary">\s*([\d,]+(?:\.\d+)?)[\s\S]*?class="main-table-number">\s*([\d,]+(?:\.\d+)?)[\s\S]*?class="main-table-number">\s*([\d,]+)/g;

/** 页面自带的默认分区与难度，读出来就不必把版本号写死在代码里。 */
export function parseDefaults(html: string): ZoneDefaults | null {
  const partition = toNumber(/var defaultPartition = (\d+)/.exec(html)?.[1]);
  const difficulty = toNumber(/obj = \{ difficulty: (\d+), sizes: \[\] \}/.exec(html)?.[1]);
  const size = toNumber(/obj\.sizes\.push\((\d+)\)/.exec(html)?.[1]);
  const sample = toNumber(/var defaultSample = (\d+)/.exec(html)?.[1]);

  if (partition === null || difficulty === null || size === null || sample === null) return null;

  const seen = new Map<number, string>();
  for (const match of html.matchAll(/setSample\((\d+), this\)">\s*([^<]{1,24}?)\s*</g)) {
    const days = toNumber(match[1]);
    if (days !== null && !seen.has(days)) seen.set(days, (match[2] ?? "").trim());
  }

  const samples = [...seen]
    .map(([days, label]) => ({ days, label: label || `${days} 天` }))
    .sort((a, b) => b.days - a.days);

  return {
    partition,
    difficulty,
    size,
    sample,
    samples: samples.length > 0 ? samples : [{ days: sample, label: `${sample} 天` }],
  };
}

/**
 * 箱线图数据集。
 *
 * 各字段与页面上的含义已经逐一核对过：
 * q1/median/q3 即 p25/p50/p75，上须等于 p95，散点等于 p99，
 * 表格里的“最高”列才是真正的最大值，“记录数”列是官方样本量。
 */
export function parseSpreads(html: string): Map<JobKey, Spread> {
  const rows = parseTableRows(html);
  const result = new Map<JobKey, Spread>();

  for (const { job, label, block } of seriesBlocks(html)) {
    const q75 = toNumber(/var q3 = ([\d.]+);/.exec(block)?.[1]);
    const q25 = toNumber(/q1: ([\d.]+),/.exec(block)?.[1]);
    const q50 = toNumber(/median: ([\d.]+),/.exec(block)?.[1]);
    const q95 = toNumber(/high: ([\d.]+)/.exec(block)?.[1]);
    const q99 = toNumber(/singlePointSeries\.data\.push\(\{[^}]*?y: ([\d.]+)/.exec(block)?.[1]);
    const row = rows.get(job);

    if (q75 === null || q25 === null || q50 === null || q95 === null || row === undefined) continue;

    result.set(job, { label, q25, q50, q75, q95, q99: q99 ?? q95, max: row.max, sampleSize: row.sampleSize });
  }

  return result;
}

/** 单个分位的数据集：图表退化成柱状图，每个职业只剩一个数值。 */
export function parseBars(html: string): Map<JobKey, number> {
  const result = new Map<JobKey, number>();

  for (const { job, block } of seriesBlocks(html)) {
    const value = toNumber(BAR_VALUE.exec(block)?.[1]);
    if (value !== null) result.set(job, value);
  }

  return result;
}

function* seriesBlocks(html: string): Generator<{ label: string; job: JobKey; block: string }> {
  const matches = [...html.matchAll(SERIES)];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match || match.index === undefined) continue;

    yield {
      label: match[1] ?? "",
      job: match[2] ?? "",
      block: html.slice(match.index + match[0].length, matches[index + 1]?.index ?? html.length),
    };
  }
}

function parseTableRows(html: string): Map<JobKey, { max: number; sampleSize: number }> {
  const rows = new Map<JobKey, { max: number; sampleSize: number }>();

  for (const match of html.matchAll(TABLE_ROW)) {
    const job = match[1];
    const max = toNumber(match[3]?.replace(/,/g, ""));
    const sampleSize = toNumber(match[4]?.replace(/,/g, ""));
    if (job && max !== null && sampleSize !== null) rows.set(job, { max, sampleSize });
  }

  return rows;
}

function toNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
