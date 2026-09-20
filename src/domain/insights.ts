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
 * 同一阶段多把之间的相对波动超过这个比例才值得一提。
 *
 * 阈值定得高是有意的：进度期本来就把把不同，差个一两成是常态，
 * 说出来只是噪音。真正值得指出的是差到不可能只由发挥解释的那种。
 */
const VOLATILE = 0.25;

/** 最强与最弱阶段的分位差超过这么多，说明问题集中在特定阶段。 */
const UNEVEN = 25;

export function buildInsights(board: Scoreboard): Insight[] {
  return [...teamInsights(board), ...board.players.flatMap((player) => playerInsights(player))];
}

/** 全队层面的结论：某个阶段是不是集体性的短板。 */
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

  // 没有任何阶段凑齐两人时谈不上「全队最弱」，但团灭点是独立成立的，不能一起丢掉。
  const weakest = ranked[0];
  const strongest = ranked[ranked.length - 1];

  if (weakest) {
    const allBelow = weakest.belowMedian === weakest.total;
    insights.push({
      severity: allBelow ? "critical" : "note",
      subject: "",
      text:
        `${weakest.name} 是全队最弱的阶段，平均分位 ${weakest.average.toFixed(1)}，` +
        (allBelow
          ? `而且 ${weakest.total} 人全部低于官方中位。这种一致性更像是打法或循环安排的问题，不是某个人的发挥。`
          : `${weakest.total} 人中有 ${weakest.belowMedian} 人低于官方中位。`),
    });

    if (strongest && ranked.length >= 2 && strongest.average - weakest.average >= UNEVEN) {
      insights.push({
        severity: "note",
        subject: "",
        text:
          `全队在 ${strongest.name} 平均分位 ${strongest.average.toFixed(1)}，` +
          `与最弱阶段相差 ${(strongest.average - weakest.average).toFixed(1)} 分位，阶段之间很不均衡。`,
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
          ? `${total} 把里，${where} 各倒了 ${worst.count} 把，是最常团灭的两处。`
          : `${total} 把里有 ${worst.count} 把倒在 ${where}，是最常团灭的地方。`,
    });
  }

  return insights;
}

/** 按团灭次数排序的阶段。团灭点本身就是一条结论。 */
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
    return [{ severity: "note", subject: player.player, text: "没有任何阶段的官方样本足够，无法评分。" }];
  }

  const candidates: Insight[] = [];
  const weakest = player.weakest;

  if (weakest) {
    const curve = weakest.curve;
    const floor = curve ? quantile(curve, 0) : null;

    if (floor !== null && weakest.value < floor) {
      candidates.push({
        severity: "critical",
        subject: player.player,
        text:
          `最薄弱的是 ${weakest.phaseName}，${round(weakest.value)} 低于官方最低值 ${round(floor)}，` +
          `同职业同阶段没有任何一条公开记录比这更低。`,
      });
    } else if ((weakest.percentile ?? 100) < 10) {
      candidates.push({
        severity: "critical",
        subject: player.player,
        text:
          `最薄弱的是 ${weakest.phaseName}，分位 ${weakest.percentile?.toFixed(1)}，` +
          `落在同职业后 10%，比官方中位低 ${percent(-(weakest.vsMedian ?? 0))}。`,
      });
    } else if ((weakest.percentile ?? 100) < 25) {
      candidates.push({
        severity: "warning",
        subject: player.player,
        text:
          `最薄弱的是 ${weakest.phaseName}，分位 ${weakest.percentile?.toFixed(1)}，` +
          `落在同职业后 25%，比官方中位低 ${percent(-(weakest.vsMedian ?? 0))}。`,
      });
    } else {
      candidates.push({
        severity: "note",
        subject: player.player,
        text:
          `最薄弱的是 ${weakest.phaseName}，分位 ${weakest.percentile?.toFixed(1)}，` +
          `相对官方中位 ${signed(weakest.vsMedian ?? 0)}。`,
      });
    }
  }

  const strongest = player.strongest;
  if (strongest && weakest && rated.length >= 2) {
    const gap = (strongest.percentile ?? 0) - (weakest.percentile ?? 0);
    if (gap >= UNEVEN) {
      // 只有最强阶段确实打得好，才谈得上「短板集中在特定阶段」；
      // 否则落差再大也只是全程都不理想，不该给出安慰性的结论。
      const capable = (strongest.percentile ?? 0) >= 60;
      candidates.push({
        severity: "note",
        subject: player.player,
        text:
          `${strongest.phaseName} 分位 ${strongest.percentile?.toFixed(1)}，与最弱阶段相差 ${gap.toFixed(1)} 分位。` +
          (capable ? "输出能力本身没问题，短板集中在特定阶段。" : "各阶段之间落差很大。"),
      });
    }
  }

  const volatile = mostVolatile(rated);
  if (volatile) {
    const swing = (volatile.best - volatile.worst) / volatile.value;
    candidates.push({
      severity: "warning",
      subject: player.player,
      text:
        `${volatile.phaseName} 的 ${volatile.pulls} 把之间相差 ${percent(swing)}，` +
        `最好 ${round(volatile.best)}、最差 ${round(volatile.worst)}，有个别失手的 pull。` +
        `计分取的是中位数，这不会拉低分数。`,
    });
  }

  if (strongest && (strongest.percentile ?? 0) >= 90) {
    candidates.push({
      severity: "good",
      subject: player.player,
      text: `${strongest.phaseName} 分位 ${strongest.percentile?.toFixed(1)}，这一段打得很好。`,
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
