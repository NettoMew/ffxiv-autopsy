import { WINDOW_LABELS } from "../core/types.ts";
import { displayWidth, heading, padEnd, style, table } from "../core/terminal.ts";
import { quantile } from "../domain/baseline.ts";
import { buildInsights, type Severity } from "../domain/insights.ts";
import type { Scoreboard } from "../domain/scoring.ts";
import { dateOf, duration, num, paintPercentile, paintSigned } from "./format.ts";

const LABELS: Readonly<Record<Severity, string>> = {
  critical: style.red("严重"),
  warning: style.yellow("注意"),
  note: style.gray("观察"),
  good: style.green("亮点"),
};

export function renderConsole(board: Scoreboard, host: string): string {
  const lines: string[] = [];

  lines.push(
    "",
    board.anonymous
      ? style.bold(board.report.zoneName || "战斗报告")
      : `${style.bold(board.report.zoneName || board.report.title)}  ${style.gray("·")}  ${board.report.title}`,
    style.gray(
      board.anonymous
        ? dateOf(board.report.start)
        : [
            `记录者 ${board.report.owner}`,
            dateOf(board.report.start),
            `https://${host}/reports/${board.report.code}`,
          ].join("   "),
    ),
    style.gray(
      [
        `按 ${board.metricLabel} 算`,
        `比官方最近 ${WINDOW_LABELS[board.baseline.window]}`,
        `分区 ${board.baseline.partition}`,
        `一个 P 打多把时取${board.aggregate === "best" ? "最好的一把" : "中位数"}`,
      ].join("   "),
    ),
  );

  lines.push(heading("玩家总评"));
  lines.push(
    table(
      [
        { header: "玩家" },
        ...(board.anonymous ? [] : [{ header: "职业" }]),
        { header: "百分位", align: "right" },
        { header: "区间分", align: "right" },
        { header: "算分 P", align: "right" },
        { header: "最好的 P" },
        { header: "最差的 P" },
      ],
      board.players.map((player) => {
        const rated = player.phases.filter((phase) => phase.percentile !== null);
        return [
          player.display,
          ...(board.anonymous ? [] : [player.label]),
          paintPercentile(player.percentile),
          player.linear === null ? style.gray("—") : player.linear.toFixed(1),
          `${rated.length} / ${player.phases.length}`,
          player.strongest ? `${player.strongest.phaseName}` : style.gray("—"),
          player.weakest ? `${player.weakest.phaseName}` : style.gray("—"),
        ];
      }),
    ),
    style.gray("算分 P = 算进总分的 P / 有数据的 P。被团灭打断、或者官方样本太少的 P 不算分。"),
  );

  const insights = buildInsights(board);
  if (insights.length > 0) {
    lines.push(heading("点评"));
    const width = Math.max(...insights.map((insight) => displayWidth(insight.subject || "全队")));

    for (const insight of insights) {
      lines.push(`${LABELS[insight.severity]} ${padEnd(insight.subject || style.bold("全队"), width)}  ${insight.text}`);
    }
  }

  const phaseIndices = [...new Set(board.players.flatMap((player) => player.phases.map((phase) => phase.phaseIndex)))].sort(
    (a, b) => a - b,
  );

  for (const index of phaseIndices) {
    const rows = board.players
      .map((player) => ({ player, phase: player.phases.find((phase) => phase.phaseIndex === index) }))
      .filter((row): row is { player: (typeof board.players)[number]; phase: NonNullable<typeof row.phase> } => row.phase !== undefined)
      .sort((a, b) => (b.phase.percentile ?? -1) - (a.phase.percentile ?? -1));

    const sample = rows[0]?.phase;
    if (!sample) continue;

    lines.push(
      heading(sample.phaseName),
      style.gray(`平均 ${duration(sample.averageDurationMs)}   打了 ${sample.pulls} 把`),
    );

    lines.push(
      table(
        [
          { header: "玩家" },
          ...(board.anonymous ? [] : [{ header: "职业" }]),
          { header: board.metricLabel, align: "right" },
          { header: "最好", align: "right" },
          { header: "官方中位", align: "right" },
          { header: "比中位", align: "right" },
          { header: "百分位", align: "right" },
          { header: "区间分", align: "right" },
          { header: "样本数", align: "right" },
        ],
        rows.map(({ player, phase }) => [
          player.display,
          ...(board.anonymous ? [] : [player.label]),
          num(phase.value),
          num(phase.best),
          phase.curve ? num(quantile(phase.curve, 50)) : style.gray("—"),
          paintSigned(phase.vsMedian),
          phase.curve && !phase.reliable ? style.gray("样本不足") : paintPercentile(phase.percentile),
          phase.linear === null ? style.gray("—") : phase.linear.toFixed(1),
          phase.curve ? String(phase.curve.sampleSize) : style.gray("—"),
        ]),
      ),
    );
  }

  if (board.truncated.length > 0) {
    lines.push(heading("没算分的 P"));
    lines.push(
      style.gray("这些 P 被团灭打断了，和官方通关数据没法比，只列出来，不算分。"),
      table(
        [{ header: "第几把", align: "right" }, { header: "P" }, { header: "撑了多久", align: "right" }],
        board.truncated.map((item) => [`第 ${item.fightId} 把`, item.phaseName, duration(item.durationMs)]),
      ),
    );
  }

  lines.push("");
  return lines.join("\n");
}
