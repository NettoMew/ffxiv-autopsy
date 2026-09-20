import { METRICS, type Baseline, type JobCurve, type JobKey, type Metric, type PhaseWindow, type Report } from "../core/types.ts";
import type { FfLogsApi } from "../net/fflogs.ts";
import { curveFor, linearOf, percentileOf, quantile } from "./baseline.ts";
import { perSecond } from "./metrics.ts";

/** 同一名玩家在同一阶段有多次 pull 时，如何取一个代表值。 */
export type Aggregate = "median" | "best";

/**
 * 官方样本少于这个数就不给分。
 *
 * 极少有队伍从第一阶段开始打，所以首阶段的官方记录往往只有个位数。
 * 拿两三条记录当分布，谁都是满分，那不是评价而是噪声。
 */
const MIN_SAMPLE = 30;

/** 一名玩家在某一次 pull 的某个阶段里的实测结果。 */
export interface Sample {
  readonly fightId: number;
  readonly phase: PhaseWindow;
  readonly player: string;
  readonly job: JobKey;
  readonly value: number;
}

/** 一名玩家在某个阶段上的汇总评分。 */
export interface PhaseScore {
  readonly phaseIndex: number;
  readonly phaseName: string;
  readonly pulls: number;
  readonly averageDurationMs: number;
  readonly value: number;
  readonly best: number;
  readonly worst: number;
  readonly curve: JobCurve | null;
  /** 官方样本是否足够支撑一个分数。 */
  readonly reliable: boolean;
  readonly percentile: number | null;
  readonly linear: number | null;
  readonly vsMedian: number | null;
}

export interface PlayerScore {
  readonly player: string;
  readonly job: JobKey;
  readonly label: string;
  readonly phases: readonly PhaseScore[];
  /** 按阶段时长加权的分位总分。 */
  readonly percentile: number | null;
  readonly linear: number | null;
  readonly strongest: PhaseScore | null;
  readonly weakest: PhaseScore | null;
}

export interface Scoreboard {
  readonly report: Report;
  readonly metric: Metric;
  readonly metricLabel: string;
  readonly aggregate: Aggregate;
  readonly baseline: Baseline;
  readonly samples: readonly Sample[];
  readonly players: readonly PlayerScore[];
  /** 被截断、因而不计分的阶段，用于在输出里交代清楚。 */
  readonly truncated: readonly { fightId: number; phaseName: string; durationMs: number }[];
}

export interface CollectOptions {
  readonly metric: Metric;
  readonly fightId?: number | undefined;
  readonly phaseIndex?: number | undefined;
  readonly onProgress?: ((done: number, total: number, label: string) => void) | undefined;
}

/** 需要向官方基准索取哪些阶段。只取报告里真正打完过的阶段。 */
export function neededPhases(report: Report, options: { fightId?: number | undefined; phaseIndex?: number | undefined }): number[] {
  const phases = new Set<number>();

  for (const fight of report.fights) {
    if (options.fightId !== undefined && fight.id !== options.fightId) continue;
    for (const phase of fight.phases) {
      if (!phase.complete) continue;
      if (options.phaseIndex !== undefined && phase.index !== options.phaseIndex) continue;
      phases.add(phase.index);
    }
  }

  return [...phases].sort((a, b) => a - b);
}

/** 逐阶段拉取表格。每个窗口一次请求，一次就能拿到全队八个人。 */
export async function collect(api: FfLogsApi, report: Report, options: CollectOptions): Promise<Sample[]> {
  const view = METRICS[options.metric].table;
  const windows: { fight: number; phase: PhaseWindow }[] = [];

  for (const fight of report.fights) {
    if (options.fightId !== undefined && fight.id !== options.fightId) continue;
    for (const phase of fight.phases) {
      if (!phase.complete) continue;
      if (options.phaseIndex !== undefined && phase.index !== options.phaseIndex) continue;
      windows.push({ fight: fight.id, phase });
    }
  }

  const samples: Sample[] = [];
  let done = 0;

  for (const window of windows) {
    options.onProgress?.(done, windows.length, `第 ${window.fight} 把 · ${window.phase.name}`);
    const table = await api.table(view, report.code, window.phase.start, window.phase.end);

    for (const entry of table.entries) {
      samples.push({
        fightId: window.fight,
        phase: window.phase,
        player: entry.name,
        job: entry.type,
        value: perSecond(entry, table.combatTime, options.metric),
      });
    }

    done += 1;
  }

  options.onProgress?.(done, windows.length, "完成");
  return samples;
}

export function buildScoreboard(
  report: Report,
  baseline: Baseline,
  samples: readonly Sample[],
  options: { metric: Metric; aggregate: Aggregate },
): Scoreboard {
  const byPlayer = new Map<string, Map<number, Sample[]>>();

  for (const sample of samples) {
    const key = `${sample.player}\u0000${sample.job}`;
    let phases = byPlayer.get(key);
    if (!phases) {
      phases = new Map();
      byPlayer.set(key, phases);
    }
    const bucket = phases.get(sample.phase.index);
    if (bucket) bucket.push(sample);
    else phases.set(sample.phase.index, [sample]);
  }

  const players: PlayerScore[] = [];

  for (const [key, phases] of byPlayer) {
    const [player = "", job = ""] = key.split("\u0000");
    const scored: PhaseScore[] = [];

    for (const [phaseIndex, bucket] of [...phases].sort((a, b) => a[0] - b[0])) {
      const values = bucket.map((sample) => sample.value).sort((a, b) => a - b);
      const representative = options.aggregate === "best" ? (values[values.length - 1] ?? 0) : median(values);
      const curve = curveFor(baseline, phaseIndex, job);
      const reliable = curve !== null && curve.sampleSize >= MIN_SAMPLE;
      const first = bucket[0];

      scored.push({
        phaseIndex,
        phaseName: first?.phase.name ?? `阶段 ${phaseIndex}`,
        pulls: bucket.length,
        averageDurationMs: mean(bucket.map((sample) => sample.phase.durationMs)),
        value: representative,
        best: values[values.length - 1] ?? 0,
        worst: values[0] ?? 0,
        curve,
        reliable,
        percentile: reliable && curve ? percentileOf(curve, representative) : null,
        linear: reliable && curve ? linearOf(curve, representative) : null,
        vsMedian: curve ? representative / quantile(curve, 50) - 1 : null,
      });
    }

    const rated = scored.filter((phase) => phase.percentile !== null);
    const weight = rated.reduce((sum, phase) => sum + phase.averageDurationMs, 0);

    players.push({
      player,
      job,
      label: scored.find((phase) => phase.curve)?.curve?.label ?? job,
      phases: scored,
      percentile: weight > 0 ? weighted(rated, (phase) => phase.percentile ?? 0) : null,
      linear: weight > 0 ? weighted(rated, (phase) => phase.linear ?? 0) : null,
      strongest: pick(rated, (a, b) => (a.percentile ?? 0) >= (b.percentile ?? 0)),
      weakest: pick(rated, (a, b) => (a.percentile ?? 0) <= (b.percentile ?? 0)),
    });
  }

  players.sort((a, b) => (b.percentile ?? -1) - (a.percentile ?? -1));

  const truncated = report.fights.flatMap((fight) =>
    fight.phases
      .filter((phase) => !phase.complete)
      .map((phase) => ({ fightId: fight.id, phaseName: phase.name, durationMs: phase.durationMs })),
  );

  return {
    report,
    metric: options.metric,
    metricLabel: METRICS[options.metric].label,
    aggregate: options.aggregate,
    baseline,
    samples,
    players,
    truncated,
  };
}

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function weighted(phases: readonly PhaseScore[], value: (phase: PhaseScore) => number): number {
  const total = phases.reduce((sum, phase) => sum + phase.averageDurationMs, 0);
  if (total <= 0) return 0;
  return phases.reduce((sum, phase) => sum + value(phase) * phase.averageDurationMs, 0) / total;
}

function pick(phases: readonly PhaseScore[], better: (a: PhaseScore, b: PhaseScore) => boolean): PhaseScore | null {
  let chosen: PhaseScore | null = null;
  for (const phase of phases) {
    if (!chosen || better(phase, chosen)) chosen = phase;
  }
  return chosen;
}
