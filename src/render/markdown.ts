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
    `# ${board.report.zoneName || board.report.title} 阶段评分`,
    "",
    `- 日志标题：${board.report.title}`,
    `- 记录者：${board.report.owner}`,
    `- 时间：${dateOf(board.report.start)}`,
    `- 报告：https://${host}/reports/${board.report.code}`,
    `- 口径：${board.metricLabel}，对比官方 ${WINDOW_LABELS[board.baseline.window]}窗口、分区 ${board.baseline.partition}`,
    `- 多次 pull 取${board.aggregate === "best" ? "最佳" : "中位"}值`,
    "",
    "## 玩家总评",
    "",
    "| 玩家 | 职业 | 分位 | 线性 | 计分阶段 | 最强 | 最弱 |",
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

  lines.push("", "计分阶段 = 计入总分的阶段 / 有数据的阶段。被团灭截断或官方样本不足的阶段不计分。");

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
      `平均时长 ${duration(sample.averageDurationMs)}。`,
      "",
      `| 玩家 | 职业 | ${board.metricLabel} | 最佳 | 官方中位 | 相对中位 | 分位 | 线性 | 官方样本 |`,
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
    lines.push("", "## 未计分的阶段", "", "被团灭截断的阶段与官方通关数据不可比，只列出不参与评分。", "");
    lines.push("| pull | 阶段 | 时长 |", "| ---: | --- | ---: |");
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
