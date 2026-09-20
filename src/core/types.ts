/**
 * 领域模型。
 *
 * 全程只使用两个数据源：
 *   - FF Logs v1 API，提供报告内每名玩家在任意时间窗口的数值；
 *   - FF Logs 副本统计页，提供每个职业在每个阶段的官方分位曲线。
 * 两者用同一套英文职业标识（Dragoon、Sage……）对齐。
 */

/** 评分口径。rDPS 是排行榜默认口径，也是本程序默认值。 */
export type Metric = "rdps" | "adps" | "ndps" | "cdps" | "hps";

/** FF Logs 的英文职业标识，例如 "Dragoon"。 */
export type JobKey = string;

export interface MetricSpec {
  /** 统计页的 metric 段。 */
  readonly statistic: string;
  /** 统计页的 dpstype 查询参数；治疗口径下无意义但仍需占位。 */
  readonly dpsType: string;
  /** v1 报告表格接口的视图名。 */
  readonly table: "damage-done" | "healing";
  /** 表格条目中承载总量的字段。 */
  readonly field: "total" | "totalRDPS" | "totalNDPS" | "totalCDPS";
  readonly label: string;
}

export const METRICS: Readonly<Record<Metric, MetricSpec>> = {
  rdps: { statistic: "dps", dpsType: "rdps", table: "damage-done", field: "totalRDPS", label: "rDPS" },
  adps: { statistic: "dps", dpsType: "pdps", table: "damage-done", field: "total", label: "aDPS" },
  ndps: { statistic: "dps", dpsType: "ndps", table: "damage-done", field: "totalNDPS", label: "nDPS" },
  cdps: { statistic: "dps", dpsType: "cdps", table: "damage-done", field: "totalCDPS", label: "cDPS" },
  hps: { statistic: "hps", dpsType: "rdps", table: "healing", field: "total", label: "HPS" },
};

export function isMetric(value: string): value is Metric {
  return Object.hasOwn(METRICS, value);
}

/** 统计页的取样窗口。 */
export type Window = 14 | 42 | 84;

export const WINDOW_LABELS: Readonly<Record<Window, string>> = {
  14: "2 周",
  42: "6 周",
  84: "12 周",
};

/** 分位曲线上的一个点。q 为 0 表示最低值，100 表示最高值。 */
export interface Quantile {
  readonly q: number;
  readonly value: number;
}

/** 某个职业在某个阶段的官方分位曲线。 */
export interface JobCurve {
  readonly job: JobKey;
  /** 官方中文职业名。 */
  readonly label: string;
  /** 官方记录数。样本太少时评分不可信。 */
  readonly sampleSize: number;
  /** 按分位升序，数值单调不减。 */
  readonly points: readonly Quantile[];
}

/** 一个副本在某口径下的完整基准，按阶段索引组织。阶段 0 表示整场。 */
export interface Baseline {
  readonly zoneId: number;
  readonly encounterId: number;
  readonly metric: Metric;
  readonly partition: number;
  readonly window: Window;
  readonly difficulty: number;
  readonly size: number;
  readonly fetchedAt: string;
  /** 键为阶段索引的字符串形式，与报告中的 phase id 一致。 */
  readonly phases: Record<string, Record<JobKey, JobCurve>>;
}

/** 一次 pull 中被切分出来的一个阶段窗口。 */
export interface PhaseWindow {
  /** 与统计页 phase 参数、报告 phases 列表同一套编号。 */
  readonly index: number;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly durationMs: number;
  /**
   * 队伍是否完整打完了这个阶段。
   * 官方统计取自通关记录，阶段都是完整的；拿一个被团灭截断的阶段去比毫无意义，
   * 因此未打完的阶段只展示、不计分。
   */
  readonly complete: boolean;
}

/** 一名玩家在一个阶段窗口内的实测值。 */
export interface Measurement {
  readonly player: string;
  readonly job: JobKey;
  readonly value: number;
}

export interface Fight {
  readonly id: number;
  readonly encounterId: number;
  readonly name: string;
  /** 副本的中文名，逐把都带着，便于报告横跨多个副本时按 boss 取正确的那个。 */
  readonly zoneName: string;
  readonly start: number;
  readonly end: number;
  readonly combatTime: number;
  readonly kill: boolean;
  readonly phases: readonly PhaseWindow[];
}

export interface Report {
  readonly code: string;
  readonly title: string;
  /** 副本的中文名，接口只在这里给本地化文本。 */
  readonly zoneName: string;
  readonly owner: string;
  readonly zoneId: number;
  readonly start: number;
  readonly fights: readonly Fight[];
}
