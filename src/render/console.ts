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
    `${style.bold(board.report.zoneName || board.report.title)}  ${style.gray("·")}  ${board.report.title}`,
    style.gray(
      [
        `记录者 ${board.report.owner}`,
        dateOf(board.report.start),
        `https://${host}/reports/${board.report.code}`,
      ].join("   "),
    ),
    style.gray(
      [
        `口径 ${board.metricLabel}`,
        `官方窗口 ${WINDOW_LABELS[board.baseline.window]}`,
        `分区 ${board.baseline.partition}`,
        `多次 pull 取${board.aggregate === "best" ? "最佳" : "中位"}`,
      ].join("   "),
    ),
  );

  lines.push(heading("玩家总评"));
  lines.push(
    table(
      [
        { header: "玩家" },
        { header: "职业" },
        { header: "分位", align: "right" },
        { header: "线性", align: "right" },
        { header: "计分阶段", align: "right" },
        { header: "最强" },
        { header: "最弱" },
      ],
      board.players.map((player) => {
        const rated = player.phases.filter((phase) => phase.percentile !== null);
        return [
          player.player,
          player.label,
          paintPercentile(player.percentile),
          player.linear === null ? style.gray("—") : player.linear.toFixed(1),
          `${rated.length} / ${player.phases.length}`,
          player.strongest ? `${player.strongest.phaseName}` : style.gray("—"),
          player.weakest ? `${player.weakest.phaseName}` : style.gray("—"),
        ];
      }),
    ),
    style.gray("计分阶段 = 计入总分的阶段 / 有数据的阶段。被团灭截断或官方样本不足的阶段不计分。"),
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
      style.gray(`平均时长 ${duration(sample.averageDurationMs)}   ${sample.pulls} 次记录`),
    );

    lines.push(
      table(
        [
          { header: "玩家" },
          { header: "职业" },
          { header: board.metricLabel, align: "right" },
          { header: "最佳", align: "right" },
          { header: "官方中位", align: "right" },
          { header: "相对中位", align: "right" },
          { header: "分位", align: "right" },
          { header: "线性", align: "right" },
          { header: "官方样本", align: "right" },
        ],
        rows.map(({ player, phase }) => [
          player.player,
          player.label,
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
    lines.push(heading("未计分的阶段"));
    lines.push(
      style.gray("被团灭截断的阶段与官方通关数据不可比，只列出不参与评分。"),
      table(
        [{ header: "pull", align: "right" }, { header: "阶段" }, { header: "时长", align: "right" }],
        board.truncated.map((item) => [`第 ${item.fightId} 把`, item.phaseName, duration(item.durationMs)]),
      ),
    );
  }

  lines.push("");
  return lines.join("\n");
}
