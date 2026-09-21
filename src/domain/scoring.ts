import { METRICS, OVERALL, type Baseline, type JobCurve, type JobKey, type Metric, type PhaseWindow, type Report } from "../core/types.ts";
import type { FfLogsApi } from "../net/fflogs.ts";
import { curveFor, linearOf, percentileOf, quantile } from "./baseline.ts";
import { perSecond } from "./metrics.ts";

/** 同一个人在同一个 P 打了多把时，怎么取一个代表值。 */
export type Aggregate = "trimmed" | "median" | "best";

export const AGGREGATE_LABELS: Readonly<Record<Aggregate, string>> = {
  trimmed: "去掉最好最差后取平均",
  median: "中位数",
  best: "最好的一把",
};

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
  /** 输出里用的名字。匿名模式下是职业名，否则就是角色名。 */
  readonly display: string;
  /** 各个 P 的成绩，不含整场。 */
  readonly phases: readonly PhaseScore[];
  /**
   * 通关那把的整场成绩，没通关就是空。
   *
   * 不并进逐 P 的总分里：整场本来就是各 P 之和，混在一起等于把同一份成绩数了两遍。
   */
  readonly overall: PhaseScore | null;
  /** 按各 P 时长加权的百分位总分。 */
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
  /**
   * 匿名模式：角色名换成职业名，不输出记录者与报告地址。
   *
   * 默认开着。这类报告十有八九是要发给一群人看的，
   * 默认把名字亮出来等于默认在点名，不合适。
   */
  readonly anonymous: boolean;
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
  options: { metric: Metric; aggregate: Aggregate; anonymous: boolean },
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
      const representative = aggregate(values, options.aggregate);
      const curve = curveFor(baseline, phaseIndex, job);
      const reliable = curve !== null && curve.sampleSize >= MIN_SAMPLE;
      const first = bucket[0];

      scored.push({
        phaseIndex,
        phaseName: first?.phase.name ?? `P${phaseIndex}`,
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

    const overall = scored.find((phase) => phase.phaseIndex === OVERALL) ?? null;
    const perPhase = scored.filter((phase) => phase.phaseIndex !== OVERALL);
    const rated = perPhase.filter((phase) => phase.percentile !== null);
    const weight = rated.reduce((sum, phase) => sum + phase.averageDurationMs, 0);

    players.push({
      player,
      job,
      display: player,
      label: scored.find((phase) => phase.curve)?.curve?.label ?? job,
      phases: perPhase,
      overall,
      percentile: weight > 0 ? weighted(rated, (phase) => phase.percentile ?? 0) : null,
      linear: weight > 0 ? weighted(rated, (phase) => phase.linear ?? 0) : null,
      strongest: pick(rated, (a, b) => (a.percentile ?? 0) >= (b.percentile ?? 0)),
      weakest: pick(rated, (a, b) => (a.percentile ?? 0) <= (b.percentile ?? 0)),
    });
  }

  players.sort((a, b) => (b.percentile ?? -1) - (a.percentile ?? -1));
  const named = withDisplayNames(players, options.anonymous);

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
    anonymous: options.anonymous,
    baseline,
    samples,
    players: named,
    truncated,
  };
}

/**
 * 决定每个人在输出里叫什么。
 *
 * 匿名模式下用职业名代替角色名。一队里出现两个同职业时补上序号，
 * 否则两行都叫「钐镰客」，谁是谁就说不清了。
 */
function withDisplayNames(players: readonly PlayerScore[], anonymous: boolean): PlayerScore[] {
  if (!anonymous) return [...players];

  const totals = new Map<string, number>();
  for (const player of players) totals.set(player.label, (totals.get(player.label) ?? 0) + 1);

  const seen = new Map<string, number>();
  return players.map((player) => {
    if ((totals.get(player.label) ?? 1) === 1) return { ...player, display: player.label };
    const ordinal = (seen.get(player.label) ?? 0) + 1;
    seen.set(player.label, ordinal);
    return { ...player, display: `${player.label} ${ordinal}` };
  });
}

/**
 * 把一个 P 的多把成绩收成一个数。
 *
 * 默认去掉最好和最差再取平均：既挡得住单次翻车，又不像中位数那样把其余各把的
 * 高低整个丢掉。七把里有三把明显更好时，中位数会落在低的那一簇里，看不出上限。
 * 不足三把时没得去头尾，退回中位数（两把就是两把的平均）。
 */
function aggregate(sorted: readonly number[], how: Aggregate): number {
  if (how === "best") return sorted[sorted.length - 1] ?? 0;
  if (how === "median" || sorted.length <= 2) return median(sorted);
  return mean(sorted.slice(1, -1));
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
