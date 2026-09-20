import { quantile } from "../domain/baseline.ts";
import type { Sample, Scoreboard } from "../domain/scoring.ts";

/** 汇总表：每名玩家每个阶段一行，带官方分位锚点，方便自己再加工。 */
export function renderCsv(board: Scoreboard): string {
  const header = [
    "玩家",
    "职业",
    "阶段编号",
    "阶段",
    "记录数",
    "平均时长秒",
    `${board.metricLabel}代表值`,
    `${board.metricLabel}最佳`,
    "官方最低",
    "官方p25",
    "官方中位",
    "官方p75",
    "官方p95",
    "官方最高",
    "官方样本",
    "相对中位",
    "分位",
    "线性",
  ];

  const rows = board.players.flatMap((player) =>
    player.phases.map((phase) => [
      player.player,
      player.label,
      phase.phaseIndex,
      phase.phaseName,
      phase.pulls,
      (phase.averageDurationMs / 1000).toFixed(1),
      phase.value.toFixed(2),
      phase.best.toFixed(2),
      phase.curve ? quantile(phase.curve, 0).toFixed(2) : "",
      phase.curve ? quantile(phase.curve, 25).toFixed(2) : "",
      phase.curve ? quantile(phase.curve, 50).toFixed(2) : "",
      phase.curve ? quantile(phase.curve, 75).toFixed(2) : "",
      phase.curve ? quantile(phase.curve, 95).toFixed(2) : "",
      phase.curve ? quantile(phase.curve, 100).toFixed(2) : "",
      phase.curve ? phase.curve.sampleSize : "",
      phase.vsMedian === null ? "" : (phase.vsMedian * 100).toFixed(2),
      phase.percentile === null ? "" : phase.percentile.toFixed(2),
      phase.linear === null ? "" : phase.linear.toFixed(2),
    ]),
  );

  return toCsv([header, ...rows]);
}

/** 明细表：每一次 pull 的每一个阶段一行，保留最原始的实测值。 */
export function renderSamplesCsv(board: Scoreboard): string {
  const header = ["pull", "阶段编号", "阶段", "时长秒", "玩家", "职业", board.metricLabel];
  const rows = board.samples.map((sample: Sample) => [
    sample.fightId,
    sample.phase.index,
    sample.phase.name,
    (sample.phase.durationMs / 1000).toFixed(1),
    sample.player,
    sample.job,
    sample.value.toFixed(2),
  ]);

  return toCsv([header, ...rows]);
}

function toCsv(rows: readonly (readonly (string | number)[])[]): string {
  // 带 BOM，Excel 打开中文不会乱码。
  return `﻿${rows.map((row) => row.map(escape).join(",")).join("\r\n")}\r\n`;
}

function escape(cell: string | number): string {
  const text = String(cell);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
