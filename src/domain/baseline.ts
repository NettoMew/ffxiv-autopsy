import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT } from "../core/config.ts";
import type { Baseline, JobCurve, JobKey, Metric, Window } from "../core/types.ts";
import type { StatisticsSource, ZoneDefaults } from "../net/statistics.ts";

const DIR = resolve(ROOT, "data", "baseline");

export interface BaselineKey {
  readonly zoneId: number;
  readonly encounterId: number;
  readonly metric: Metric;
  readonly window: Window;
}

/**
 * 基准库是惰性的：只抓当前这份报告真正用得到的阶段，抓过的永久留在磁盘上。
 * 第一次评一个新副本要几十次请求，之后再评同一副本是零请求。
 */
export async function ensureBaseline(
  source: StatisticsSource,
  key: BaselineKey,
  phases: readonly number[],
  onFetch?: (phase: number) => void,
): Promise<Baseline> {
  const defaults = await source.defaults(key.zoneId, key.encounterId);
  const existing = read(key, defaults.partition);

  const collected: Record<string, Record<JobKey, JobCurve>> = { ...(existing?.phases ?? {}) };
  let changed = false;

  for (const phase of [...new Set(phases)].sort((a, b) => a - b)) {
    if (collected[String(phase)]) continue;
    onFetch?.(phase);
    collected[String(phase)] = await source.curves({ ...key, phase }, defaults);
    changed = true;
  }

  const baseline: Baseline = {
    zoneId: key.zoneId,
    encounterId: key.encounterId,
    metric: key.metric,
    partition: defaults.partition,
    window: key.window,
    difficulty: defaults.difficulty,
    size: defaults.size,
    fetchedAt: changed ? new Date().toISOString() : (existing?.fetchedAt ?? new Date().toISOString()),
    phases: collected,
  };

  if (changed) write(baseline);
  return baseline;
}

export function curveFor(baseline: Baseline, phase: number, job: JobKey): JobCurve | null {
  return baseline.phases[String(phase)]?.[job] ?? null;
}

/**
 * 数值在官方分布中的百分位。
 *
 * 曲线上有 0/10/25/50/75/90/95/99/100 九个官方锚点，之间按线性插值。
 * 相比直接用最低最高做归一，分位不会被一个开场就阵亡的极端样本带偏。
 */
export function percentileOf(curve: JobCurve, value: number): number {
  const points = curve.points;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return 0;

  if (value <= first.value) return first.q;
  if (value >= last.value) return last.q;

  for (let index = 1; index < points.length; index += 1) {
    const lower = points[index - 1];
    const upper = points[index];
    if (!lower || !upper || value > upper.value) continue;

    const span = upper.value - lower.value;
    const ratio = span <= 0 ? 0 : (value - lower.value) / span;
    return lower.q + (upper.q - lower.q) * ratio;
  }

  return last.q;
}

/** 使用者最初要的那种打分：在最低值与最高值之间做线性归一。 */
export function linearOf(curve: JobCurve, value: number): number {
  const min = quantile(curve, 0);
  const max = quantile(curve, 100);
  if (max <= min) return 0;
  return clamp(((value - min) / (max - min)) * 100, 0, 100);
}

export function quantile(curve: JobCurve, q: number): number {
  for (const point of curve.points) {
    if (point.q === q) return point.value;
  }

  const first = curve.points[0];
  return first ? first.value : 0;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function path(key: BaselineKey, partition: number): string {
  return join(DIR, `${key.zoneId}-${key.encounterId}-${key.metric}-p${partition}-w${key.window}.json`);
}

function read(key: BaselineKey, partition: number): Baseline | null {
  try {
    return JSON.parse(readFileSync(path(key, partition), "utf8")) as Baseline;
  } catch {
    return null;
  }
}

function write(baseline: Baseline): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(
    path(
      {
        zoneId: baseline.zoneId,
        encounterId: baseline.encounterId,
        metric: baseline.metric,
        window: baseline.window,
      },
      baseline.partition,
    ),
    `${JSON.stringify(baseline, null, 2)}\n`,
    "utf8",
  );
}

export const BASELINE_DIR = DIR;
