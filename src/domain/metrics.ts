import { METRICS, type Metric } from "../core/types.ts";
import type { TableEntry } from "../net/fflogs.ts";

/**
 * 把表格条目换算成每秒数值。
 *
 * 除数必须是 combatTime 而不是窗口长度：用 combatTime 复算排行榜第一名的 rDPS，
 * 与官方公布值在 1e-11 量级上一致，说明这就是 FF Logs 自己用的公式。
 */
export function perSecond(entry: TableEntry, combatTimeMs: number, metric: Metric): number {
  if (combatTimeMs <= 0) return 0;
  const field = METRICS[metric].field;
  const total = field === "total" ? entry.total : (entry[field] ?? entry.total);
  return total / (combatTimeMs / 1000);
}
