import { WINDOW_LABELS } from "../core/types.ts";
import { quantile } from "../domain/baseline.ts";
import { buildInsights, type Severity } from "../domain/insights.ts";
import type { Scoreboard } from "../domain/scoring.ts";
import { dateOf, duration, num, signedPercent } from "./format.ts";

const MARKS: Readonly<Record<Severity, string>> = {
  critical: "严重",
  warning: "注意",
  note: "观察",
  good: "亮点",
};

export function renderMarkdown(board: Scoreboard, host: string): string {
  const lines: string[] = [];

  lines.push(
    `# ${board.report.zoneName || board.report.title} 逐 P 评分`,
    "",
    `- 日志标题：${board.report.title}`,
    `- 记录者：${board.report.owner}`,
    `- 时间：${dateOf(board.report.start)}`,
    `- 报告：https://${host}/reports/${board.report.code}`,
    `- 口径：${board.metricLabel}，比的是官方最近 ${WINDOW_LABELS[board.baseline.window]}、分区 ${board.baseline.partition} 的数据`,
    `- 同一个 P 打了多把时，取${board.aggregate === "best" ? "最好的一把" : "中位数"}`,
    "",
    "## 玩家总评",
    "",
    "| 玩家 | 职业 | 百分位 | 区间分 | 算分 P | 最好的 P | 最差的 P |",
    "| --- | --- | ---: | ---: | ---: | --- | --- |",
  );

  for (const player of board.players) {
    const rated = player.phases.filter((phase) => phase.percentile !== null);
    lines.push(
      row([
        player.player,
        player.label,
        player.percentile === null ? "—" : player.percentile.toFixed(1),
        player.linear === null ? "—" : player.linear.toFixed(1),
        `${rated.length} / ${player.phases.length}`,
        player.strongest?.phaseName ?? "—",
        player.weakest?.phaseName ?? "—",
      ]),
    );
  }

  lines.push("", "算分 P = 算进总分的 P / 有数据的 P。被团灭打断、或者官方样本太少的 P 不算分。");

  const insights = buildInsights(board);
  if (insights.length > 0) {
    lines.push("", "## 点评", "", "| 程度 | 对象 | 结论 |", "| --- | --- | --- |");
    for (const insight of insights) {
      lines.push(row([MARKS[insight.severity], insight.subject || "全队", insight.text]));
    }
  }

  const phaseIndices = [
    ...new Set(board.players.flatMap((player) => player.phases.map((phase) => phase.phaseIndex))),
  ].sort((a, b) => a - b);

  for (const index of phaseIndices) {
    const rows = board.players
      .map((player) => ({ player, phase: player.phases.find((phase) => phase.phaseIndex === index) }))
      .filter((row) => row.phase !== undefined)
      .sort((a, b) => (b.phase?.percentile ?? -1) - (a.phase?.percentile ?? -1));

    const sample = rows[0]?.phase;
    if (!sample) continue;

    lines.push(
      "",
      `## ${sample.phaseName}`,
      "",
      `平均 ${duration(sample.averageDurationMs)}，打了 ${sample.pulls} 把。`,
      "",
      `| 玩家 | 职业 | ${board.metricLabel} | 最好 | 官方中位 | 比中位 | 百分位 | 区间分 | 样本数 |`,
      "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    );

    for (const { player, phase } of rows) {
      if (!phase) continue;
      lines.push(
        row([
          player.player,
          player.label,
          num(phase.value),
          num(phase.best),
          phase.curve ? num(quantile(phase.curve, 50)) : "—",
          signedPercent(phase.vsMedian),
          phase.curve && !phase.reliable ? "样本不足" : phase.percentile === null ? "—" : phase.percentile.toFixed(1),
          phase.linear === null ? "—" : phase.linear.toFixed(1),
          phase.curve ? String(phase.curve.sampleSize) : "—",
        ]),
      );
    }
  }

  if (board.truncated.length > 0) {
    lines.push("", "## 没算分的 P", "", "这些 P 被团灭打断了，和官方通关数据没法比，只列出来，不算分。", "");
    lines.push("| 第几把 | P | 撑了多久 |", "| ---: | --- | ---: |");
    for (const item of board.truncated) {
      lines.push(row([`第 ${item.fightId} 把`, item.phaseName, duration(item.durationMs)]));
    }
  }

  lines.push("");
  return lines.join("\n");
}

function row(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}
