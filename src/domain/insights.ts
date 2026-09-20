import { quantile } from "./baseline.ts";
import type { PhaseScore, PlayerScore, Scoreboard } from "./scoring.ts";

/**
 * 点评。
 *
 * 表格给的是数字，这里负责把数字里真正值得开口说的部分挑出来。
 * 每一条结论都由一个算得出来的量支撑，并且把那个量一并写进句子，
 * 读的人可以立刻回表格核对，不必信任本模块的判断。
 */

export type Severity = "critical" | "warning" | "note" | "good";

export interface Insight {
  readonly severity: Severity;
  /** 玩家名，或全队结论的空字符串。 */
  readonly subject: string;
  readonly text: string;
}

/**
 * 同一个 P 的几把之间差得超过这个比例才值得一提。
 *
 * 阈值定得高是有意的：开荒本来就把把不同，差个一两成是常态，
 * 说出来只是噪音。真正值得指出的是差到不可能只由发挥解释的那种。
 */
const VOLATILE = 0.25;

/** 最好与最薄弱的 P 差出这么多分，说明问题集中在个别 P。 */
const UNEVEN = 25;

export function buildInsights(board: Scoreboard): Insight[] {
  return [...teamInsights(board), ...board.players.flatMap((player) => playerInsights(player))];
}

/** 全队层面的结论：某个 P 是不是集体性的短板。 */
function teamInsights(board: Scoreboard): Insight[] {
  const byPhase = new Map<number, { name: string; scores: PhaseScore[] }>();

  for (const player of board.players) {
    for (const phase of player.phases) {
      if (phase.percentile === null) continue;
      const bucket = byPhase.get(phase.phaseIndex);
      if (bucket) bucket.scores.push(phase);
      else byPhase.set(phase.phaseIndex, { name: phase.phaseName, scores: [phase] });
    }
  }

  const ranked = [...byPhase.values()]
    .filter((bucket) => bucket.scores.length >= 2)
    .map((bucket) => ({
      name: bucket.name,
      average: mean(bucket.scores.map((phase) => phase.percentile ?? 0)),
      belowMedian: bucket.scores.filter((phase) => (phase.vsMedian ?? 0) < 0).length,
      total: bucket.scores.length,
    }))
    .sort((a, b) => a.average - b.average);

  const insights: Insight[] = [];

  // 没有任何一个 P 凑齐两人时谈不上「全队最吃力」，但团灭点是独立成立的，不能一起丢掉。
  const weakest = ranked[0];
  const strongest = ranked[ranked.length - 1];

  if (weakest) {
    const allBelow = weakest.belowMedian === weakest.total;
    insights.push({
      severity: allBelow ? "critical" : "note",
      subject: "",
      text:
        `全队最吃力的是 ${weakest.name}，平均 ${weakest.average.toFixed(1)} 分，` +
        (allBelow
          ? `而且 ${weakest.total} 个人全部低于官方中位。这么整齐更像是打法或者爆发轴的问题，不是某一个人手法的事。`
          : `${weakest.total} 个人里有 ${weakest.belowMedian} 个低于官方中位。`),
    });

    if (strongest && ranked.length >= 2 && strongest.average - weakest.average >= UNEVEN) {
      insights.push({
        severity: "note",
        subject: "",
        text:
          `全队在 ${strongest.name} 能打到 ${strongest.average.toFixed(1)} 分，` +
          `和最吃力那个 P 差了 ${(strongest.average - weakest.average).toFixed(1)} 分，各 P 之间很不平均。`,
      });
    }
  }

  const wipes = wipePhases(board);
  const worst = wipes[0];
  if (worst && worst.count >= 2) {
    const total = board.report.fights.length;
    const tied = wipes.filter((entry) => entry.count === worst.count);
    const where = tied.map((entry) => entry.name).join("、");
    insights.push({
      severity: "note",
      subject: "",
      text:
        tied.length > 1
          ? `${total} 把里 ${where} 各倒了 ${worst.count} 把，是团灭最多的两个 P。`
          : `${total} 把里有 ${worst.count} 把倒在 ${where}，是团灭最多的地方。`,
    });
  }

  return insights;
}

/** 按团灭次数排序的 P。倒在哪里本身就是一条结论。 */
export function wipePhases(board: Scoreboard): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of board.truncated) counts.set(item.phaseName, (counts.get(item.phaseName) ?? 0) + 1);
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/** 单个玩家的结论，按严重程度取最值得说的前两条。 */
function playerInsights(player: PlayerScore): Insight[] {
  const rated = player.phases.filter((phase) => phase.percentile !== null);
  if (rated.length === 0) {
    return [{ severity: "note", subject: player.display, text: "所有 P 的官方样本都太少，算不出分。" }];
  }

  const candidates: Insight[] = [];
  const weakest = player.weakest;

  if (weakest) {
    const curve = weakest.curve;
    const floor = curve ? quantile(curve, 0) : null;

    if (floor !== null && weakest.value < floor) {
      candidates.push({
        severity: "critical",
        subject: player.display,
        text:
          `最薄弱的是 ${weakest.phaseName}，${round(weakest.value)} 比官方最低值 ${round(floor)} 还低，` +
          `同职业在这个 P 没有一条公开记录比这更差。`,
      });
    } else if ((weakest.percentile ?? 100) < 10) {
      candidates.push({
        severity: "critical",
        subject: player.display,
        text:
          `最薄弱的是 ${weakest.phaseName}，${weakest.percentile?.toFixed(1)} 分，` +
          `排在同职业最后 10%，比官方中位低 ${percent(-(weakest.vsMedian ?? 0))}。`,
      });
    } else if ((weakest.percentile ?? 100) < 25) {
      candidates.push({
        severity: "warning",
        subject: player.display,
        text:
          `最薄弱的是 ${weakest.phaseName}，${weakest.percentile?.toFixed(1)} 分，` +
          `排在同职业最后 25%，比官方中位低 ${percent(-(weakest.vsMedian ?? 0))}。`,
      });
    } else {
      candidates.push({
        severity: "note",
        subject: player.display,
        text:
          `最薄弱的是 ${weakest.phaseName}，${weakest.percentile?.toFixed(1)} 分，` +
          `相比官方中位 ${signed(weakest.vsMedian ?? 0)}。`,
      });
    }
  }

  const strongest = player.strongest;
  if (strongest && weakest && rated.length >= 2) {
    const gap = (strongest.percentile ?? 0) - (weakest.percentile ?? 0);
    if (gap >= UNEVEN) {
      // 只有最好的那个 P 确实打得好，才谈得上「短板集中在个别 P」；
      // 否则落差再大也只是全程都不理想，不该给出安慰性的结论。
      const capable = (strongest.percentile ?? 0) >= 60;
      candidates.push({
        severity: "note",
        subject: player.display,
        text:
          `${strongest.phaseName} 能打到 ${strongest.percentile?.toFixed(1)} 分，和最薄弱那个 P 差了 ${gap.toFixed(1)} 分。` +
          (capable ? "输出本身没问题，短板集中在个别 P。" : "各 P 之间落差很大。"),
      });
    }
  }

  const volatile = mostVolatile(rated);
  if (volatile) {
    const swing = (volatile.best - volatile.worst) / volatile.value;
    candidates.push({
      severity: "warning",
      subject: player.display,
      text:
        `${volatile.phaseName} 打了 ${volatile.pulls} 把，最好 ${round(volatile.best)}、最差 ${round(volatile.worst)}，` +
        `差了 ${percent(swing)}，中间有几把明显失手。总分取的是中位数，个别翻车不影响分数。`,
    });
  }

  if (strongest && (strongest.percentile ?? 0) >= 90) {
    candidates.push({
      severity: "good",
      subject: player.display,
      text: `${strongest.phaseName} 打到 ${strongest.percentile?.toFixed(1)} 分，这个 P 打得很好。`,
    });
  }

  // 最薄弱那一条永远保留，它是这份点评的主干；其余按严重程度补一条。
  const [primary, ...rest] = candidates;
  const extra = rank(rest)[0];
  return extra ? [primary as Insight, extra] : primary ? [primary] : [];
}

const ORDER: Readonly<Record<Severity, number>> = { critical: 0, warning: 1, note: 2, good: 3 };

function rank(insights: readonly Insight[]): Insight[] {
  return [...insights].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

function mostVolatile(phases: readonly PhaseScore[]): PhaseScore | null {
  let chosen: PhaseScore | null = null;
  let widest = VOLATILE;

  for (const phase of phases) {
    if (phase.pulls < 3 || phase.value <= 0) continue;
    const swing = (phase.best - phase.worst) / phase.value;
    if (swing > widest) {
      widest = swing;
      chosen = phase;
    }
  }

  return chosen;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): string {
  return Math.round(value).toLocaleString("zh-CN");
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function signed(ratio: number): string {
  return `${ratio >= 0 ? "+" : ""}${(ratio * 100).toFixed(1)}%`;
}
