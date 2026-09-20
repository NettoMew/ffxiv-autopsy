import { WINDOW_LABELS } from "../core/types.ts";
import { quantile } from "../domain/baseline.ts";
import { buildInsights, wipePhases, type Severity } from "../domain/insights.ts";
import type { PhaseScore, PlayerScore, Scoreboard } from "../domain/scoring.ts";
import { bandOf, dateOf, duration, num, signedPercent } from "./format.ts";

/**
 * 自包含的单文件报告，不引用任何外部资源，可以直接发给队友。
 *
 * 版面以分位矩阵开头。同样一组数字，排成五张互不相干的明细表，和排成一张
 * 玩家乘阶段的矩阵，读出来的东西完全不同：矩阵里一行横着看是某人哪一段塌了，
 * 一列竖着看是全队在哪一段集体吃力，都不需要来回翻。
 * 明细表照旧提供，但收进折叠块，要核对时再展开；导出图片时一律摊开。
 */
export interface HtmlOptions {
  /**
   * 为导出图片而渲染：各阶段明细与未计分阶段一律摊开。
   * 网页里这几块是折叠的，点一下就展开；静态图片点不动，收着等于没有。
   */
  readonly forImage?: boolean;
}

export function renderHtml(board: Scoreboard, host: string, options: HtmlOptions = {}): string {
  const title = `${board.report.zoneName || board.report.title} 阶段评分`;
  const phases = phaseColumns(board);
  const open = options.forImage === true;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${header(board, host)}
${overview(board)}
${matrix(board, phases)}
${insightSection(board)}
${phases.map((phase) => phaseSection(board, phase, open)).join("\n")}
${truncatedSection(board, open)}
${footer(open)}
</main>
</body>
</html>
`;
}

interface PhaseColumn {
  readonly index: number;
  readonly short: string;
  readonly full: string;
}

/** 矩阵的列。长长的英文阶段名在表头里放不下，取冒号前的那一段，全名留在悬停提示里。 */
function phaseColumns(board: Scoreboard): PhaseColumn[] {
  const seen = new Map<number, string>();

  for (const player of board.players) {
    for (const phase of player.phases) {
      if (!seen.has(phase.phaseIndex)) seen.set(phase.phaseIndex, phase.phaseName);
    }
  }

  return [...seen]
    .sort((a, b) => a[0] - b[0])
    .map(([index, full]) => ({ index, full, short: full.split(":")[0]?.trim() || full }));
}

/** 一个人都没算出分的阶段。留在矩阵里只是一整列「样本不足」，白占版面。 */
function isScored(board: Scoreboard, index: number): boolean {
  return board.players.some((player) =>
    player.phases.some((phase) => phase.phaseIndex === index && phase.percentile !== null),
  );
}

function header(board: Scoreboard, host: string): string {
  return `  <header>
    <h1>${escape(board.report.zoneName || board.report.title)}</h1>
    <p class="subtitle">${escape(board.report.title)} · ${escape(dateOf(board.report.start))} · 记录者 ${escape(board.report.owner)}</p>
    <p class="subtitle">
      <a href="https://${escape(host)}/reports/${escape(board.report.code)}">${escape(board.report.code)}</a>
      · ${escape(board.metricLabel)}
      · 官方 ${escape(WINDOW_LABELS[board.baseline.window])}窗口
      · 分区 ${board.baseline.partition}
      · 多次 pull 取${board.aggregate === "best" ? "最佳" : "中位"}值
    </p>
  </header>`;
}

function overview(board: Scoreboard): string {
  const rated = board.players.filter((player) => player.percentile !== null);
  const average = rated.length > 0 ? rated.reduce((sum, player) => sum + (player.percentile ?? 0), 0) / rated.length : 0;
  const wipes = wipePhases(board);
  const worst = wipes[0];
  const tied = worst ? wipes.filter((entry) => entry.count === worst.count) : [];

  const cards: { label: string; value: string; hint: string }[] = [
    { label: "有效 pull", value: String(board.report.fights.length), hint: "排除杂兵段落后" },
    { label: "参与玩家", value: String(board.players.length), hint: "至少有一个计分阶段" },
    {
      label: "全队平均分位",
      value: rated.length > 0 ? average.toFixed(1) : "—",
      hint: rated.length > 0 ? `${rated.length} 人的总评均值` : "无可计分数据",
    },
    {
      label: "最常团灭",
      value: worst ? tied.map((entry) => entry.name.split(":")[0]?.trim() ?? entry.name).join(" / ") : "—",
      hint: worst ? `各 ${worst.count} 把` : "没有被截断的阶段",
    },
  ];

  return `  <section class="overview">
${cards
  .map(
    (card) => `    <div class="card">
      <span class="card-label">${escape(card.label)}</span>
      <strong class="card-value">${escape(card.value)}</strong>
      <span class="card-hint">${escape(card.hint)}</span>
    </div>`,
  )
  .join("\n")}
  </section>`;
}

/** 分位矩阵：一行是一个人，一列是一个阶段，格子的颜色就是分位。 */
function matrix(board: Scoreboard, all: readonly PhaseColumn[]): string {
  const phases = all.filter((phase) => isScored(board, phase.index));
  const dropped = all.filter((phase) => !isScored(board, phase.index));
  if (phases.length === 0) return "";

  const head = phases
    .map((phase) => `<th class="c" title="${escape(phase.full)}">${escape(phase.short)}</th>`)
    .join("");

  const body = board.players
    .map((player) => {
      const cells = phases.map((phase) => cell(player, phase)).join("");
      return `        <tr>
          <td class="name">${escape(player.player)}</td>
          <td class="muted">${escape(player.label)}</td>
${cells}
          <td class="c total">${score(player.percentile)}</td>
          <td class="c muted small">${rated(player)}</td>
        </tr>`;
    })
    .join("\n");

  return `  <section>
    <h2>分位矩阵</h2>
    <p class="subtitle">横看是某人哪一段塌了，竖看是全队在哪一段吃力。悬停格子可以看到原始数值。</p>
    <div class="scroll">
      <table class="matrix">
        <thead><tr><th>玩家</th><th>职业</th>${head}<th class="c">总评</th><th class="c">计分</th></tr></thead>
        <tbody>
${body}
        </tbody>
      </table>
    </div>
    <p class="note">计分列为「计入总分的阶段 / 有数据的阶段」。被团灭截断或官方样本不足的阶段不计分。${dropped.length > 0 ? `${escape(dropped.map((phase) => phase.full).join("、"))} 全员样本不足，未列入矩阵，明细仍可展开。` : ""}</p>
${legend()}
  </section>`;
}

function cell(player: PlayerScore, column: PhaseColumn): string {
  const phase = player.phases.find((item) => item.phaseIndex === column.index);
  if (!phase) return `          <td class="c empty">·</td>`;

  if (phase.percentile === null) {
    const why = phase.curve ? `官方样本仅 ${phase.curve.sampleSize} 条，不足以评分` : "没有官方基准";
    return `          <td class="c empty" title="${escape(why)}">样本不足</td>`;
  }

  const hex = bandOf(phase.percentile).hex;
  const tip = [
    column.full,
    `${num(phase.value)}（${phase.pulls} 把取${phase.pulls > 1 ? "中位" : "单把"}）`,
    phase.curve ? `官方中位 ${num(quantile(phase.curve, 50))}` : "",
    `相对中位 ${signedPercent(phase.vsMedian)}`,
    phase.curve ? `官方样本 ${phase.curve.sampleSize}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return `          <td class="c"><span class="chip" style="background:${hex}22;border-color:${hex}55;color:${hex}" title="${escape(tip)}">${phase.percentile.toFixed(0)}</span></td>`;
}

function rated(player: PlayerScore): string {
  return `${player.phases.filter((phase) => phase.percentile !== null).length} / ${player.phases.length}`;
}

function legend(): string {
  const stops = [
    { from: 0, to: 25 },
    { from: 25, to: 50 },
    { from: 50, to: 75 },
    { from: 75, to: 95 },
    { from: 95, to: 99 },
    { from: 99, to: 100 },
  ];

  return `    <p class="legend">${stops
    .map((stop) => {
      const hex = bandOf(stop.from).hex;
      return `<span class="chip" style="background:${hex}22;border-color:${hex}55;color:${hex}">${stop.from}–${stop.to}</span>`;
    })
    .join("")}<span class="legend-note">配色沿用 FF Logs 的分位分段</span></p>`;
}

const SEVERITY: Readonly<Record<Severity, { label: string; color: string }>> = {
  critical: { label: "严重", color: "#e2706a" },
  warning: { label: "注意", color: "#e8b14a" },
  note: { label: "观察", color: "#8b94a5" },
  good: { label: "亮点", color: "#5fd07a" },
};

function insightSection(board: Scoreboard): string {
  const insights = buildInsights(board);
  if (insights.length === 0) return "";

  const counts = insights.reduce<Record<string, number>>((tally, insight) => {
    tally[insight.severity] = (tally[insight.severity] ?? 0) + 1;
    return tally;
  }, {});

  const summary = (["critical", "warning", "note", "good"] as const)
    .filter((severity) => counts[severity])
    .map((severity) => `${SEVERITY[severity].label} ${counts[severity]}`)
    .join(" · ");

  return `  <section>
    <h2>点评</h2>
    <p class="subtitle">${escape(summary)}。每条结论都带着支撑它的那个数，可以回矩阵核对。</p>
    <ul class="insights">
${insights
  .map((insight) => {
    const tone = SEVERITY[insight.severity];
    return `      <li><span class="tag" style="color:${tone.color};border-color:${tone.color}">${tone.label}</span><span class="who">${escape(insight.subject || "全队")}</span>${escape(insight.text)}</li>`;
  })
  .join("\n")}
    </ul>
  </section>`;
}

function phaseSection(board: Scoreboard, column: PhaseColumn, open: boolean): string {
  const rows = board.players
    .map((player) => ({ player, phase: player.phases.find((item) => item.phaseIndex === column.index) }))
    .filter((row) => row.phase !== undefined)
    .sort((a, b) => (b.phase?.percentile ?? -1) - (a.phase?.percentile ?? -1));

  const sample = rows[0]?.phase;
  if (!sample) return "";

  const caption = `${escape(column.full)}`;
  const meta = `平均 ${escape(duration(sample.averageDurationMs))} · ${sample.pulls} 次记录`;

  return `  ${block(open, caption, meta)}
    <div class="scroll">
      <table>
        <thead><tr><th>玩家</th><th>职业</th><th class="n">${escape(board.metricLabel)}</th><th class="n">最佳</th><th class="n">最差</th><th class="n">官方中位</th><th class="n">相对中位</th><th class="n">分位</th><th class="n">线性</th><th class="n">官方样本</th><th class="track-head">在官方分布中的位置</th></tr></thead>
        <tbody>
${rows
  .map(({ player, phase }) => {
    if (!phase) return "";
    return `          <tr>
            <td class="name">${escape(player.player)}</td>
            <td class="muted">${escape(player.label)}</td>
            <td class="n">${escape(num(phase.value))}</td>
            <td class="n">${escape(num(phase.best))}</td>
            <td class="n">${escape(num(phase.worst))}</td>
            <td class="n">${phase.curve ? escape(num(quantile(phase.curve, 50))) : "—"}</td>
            <td class="n ${phase.vsMedian !== null && phase.vsMedian >= 0 ? "up" : "down"}">${escape(signedPercent(phase.vsMedian))}</td>
            <td class="n">${phase.curve && !phase.reliable ? '<span class="muted">样本不足</span>' : score(phase.percentile)}</td>
            <td class="n">${phase.linear === null ? "—" : phase.linear.toFixed(1)}</td>
            <td class="n muted">${phase.curve ? phase.curve.sampleSize : "—"}</td>
            <td>${track(phase)}</td>
          </tr>`;
  })
  .join("\n")}
        </tbody>
      </table>
    </div>
  ${close(open)}`;
}

function truncatedSection(board: Scoreboard, open: boolean): string {
  if (board.truncated.length === 0) return "";

  return `  ${block(open, "未计分的阶段", `${board.truncated.length} 处，被团灭截断`)}
    <table>
      <thead><tr><th class="n">pull</th><th>阶段</th><th class="n">时长</th></tr></thead>
      <tbody>
${board.truncated
  .map(
    (item) =>
      `        <tr><td class="n">第 ${item.fightId} 把</td><td>${escape(item.phaseName)}</td><td class="n muted">${escape(duration(item.durationMs))}</td></tr>`,
  )
  .join("\n")}
      </tbody>
    </table>
  ${close(open)}`;
}

/**
 * 明细块的外壳。
 *
 * 网页里用折叠块，默认收起，需要核对时点开；导出图片时换成普通的区块，
 * 因为静态图片点不动，收着的内容等于没有。
 */
function block(open: boolean, name: string, meta: string): string {
  return open
    ? `<section class="phase open">
    <div class="phase-head"><span class="summary-name">${name}</span><span class="muted small">${meta}</span></div>`
    : `<details class="phase">
    <summary><span class="summary-name">${name}</span><span class="muted small">${meta}</span></summary>`;
}

function close(open: boolean): string {
  return open ? "</section>" : "</details>";
}

function footer(open: boolean): string {
  return `  <footer>
    <p>分位来自 FF Logs 官方副本统计的同阶段同职业分布，九个锚点之间线性插值；线性分为 100 × (实测 − 最低) ÷ (最高 − 最低)。</p>
    <p>被团灭截断的阶段与官方通关数据不可比，官方样本少于 30 条的阶段分布不成立，两者都不计分。</p>${
      open ? "\n    <p>每一把的原始数值见同名的明细 CSV。</p>" : ""
    }
  </footer>`;
}

/** 一条从官方最低到最高的轨道，刻度是 p25/p50/p75，圆点是本人所在位置。 */
function track(phase: PhaseScore): string {
  const curve = phase.curve;
  if (!curve || phase.linear === null) return "";

  const min = quantile(curve, 0);
  const max = quantile(curve, 100);
  if (max <= min) return "";

  const ticks = [25, 50, 75]
    .map((q) => (((quantile(curve, q) - min) / (max - min)) * 100).toFixed(2))
    .map((left) => `<i class="tick" style="left:${left}%"></i>`)
    .join("");

  const color = bandOf(phase.percentile ?? 0).hex;
  return `<span class="track">${ticks}<i class="dot" style="left:${phase.linear.toFixed(2)}%;background:${color}"></i></span>`;
}

function score(percentile: number | null): string {
  if (percentile === null) return "—";
  return `<b style="color:${bandOf(percentile).hex}">${percentile.toFixed(1)}</b>`;
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

const STYLE = `
:root{color-scheme:dark;--bg:#11141a;--panel:#171b23;--line:#272d38;--text:#dfe4ec;--muted:#8b94a5}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:1240px;margin:0 auto;padding:36px 20px 72px}
h1{margin:0;font-size:27px;letter-spacing:.5px}
h2{margin:0;font-size:17px;font-weight:600}
header{border-bottom:1px solid var(--line);padding-bottom:22px}
.subtitle{margin:6px 0 0;color:var(--muted);font-size:13px}
a{color:#6fb4ff;text-decoration:none}
a:hover{text-decoration:underline}
section{margin-top:38px}
.overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px}
.card-label{display:block;color:var(--muted);font-size:12px}
.card-value{display:block;margin:2px 0;font-size:22px;font-weight:600;letter-spacing:.5px}
.card-hint{display:block;color:var(--muted);font-size:11px}
.scroll{overflow-x:auto;margin-top:12px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{color:var(--muted);font-weight:500;font-size:12px;letter-spacing:.4px}
tbody tr:hover{background:var(--panel)}
.n{text-align:right}
.c{text-align:center}
.name{font-weight:600}
.muted{color:var(--muted)}
.small{font-size:12px}
.up{color:#5fd07a}
.down{color:#e2706a}
.matrix td.c{padding:5px 8px}
.matrix .total{font-size:15px}
.chip{display:inline-block;min-width:40px;padding:3px 8px;border:1px solid;border-radius:5px;font-size:13px;font-weight:600;text-align:center;cursor:default}
.empty{color:#4a515e;font-size:12px}
.note{margin:10px 0 0;color:var(--muted);font-size:12px}
.legend{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:12px 0 0}
.legend .chip{min-width:0;font-size:11px;font-weight:500}
.legend-note{color:var(--muted);font-size:11px;margin-left:6px}
.insights{list-style:none;margin:14px 0 0;padding:0}
.insights li{padding:9px 0;border-bottom:1px solid var(--line);line-height:1.7}
.insights li:last-child{border-bottom:0}
.tag{display:inline-block;min-width:34px;margin-right:10px;padding:1px 6px;border:1px solid;border-radius:3px;font-size:11px;text-align:center;vertical-align:1px}
.who{display:inline-block;min-width:88px;margin-right:10px;font-weight:600}
.phase{margin-top:10px;background:var(--panel);border:1px solid var(--line);border-radius:8px}
.phase summary{display:flex;flex-wrap:wrap;align-items:baseline;gap:12px;padding:12px 16px;cursor:pointer;list-style:none}
.phase summary::-webkit-details-marker{display:none}
.phase summary::before{content:"\\25B8";color:var(--muted);transition:transform .15s}
.phase[open] summary::before{transform:rotate(90deg)}
.phase summary:hover{background:#1c212b}
.phase.open{margin-top:22px}
.phase-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:12px;padding:12px 16px}
.summary-name{font-weight:600}
.phase table{margin:0}
.phase .scroll{margin:0;padding:0 4px 8px}
.phase td,.phase th{border-bottom-color:#212732}
.track-head{width:200px}
.track{position:relative;display:block;width:180px;height:10px;border-radius:5px;background:#232a35}
.track .tick{position:absolute;top:1px;width:1px;height:8px;background:#3c4554}
.track .dot{position:absolute;top:0;width:10px;height:10px;margin-left:-5px;border-radius:50%}
footer{margin-top:44px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
footer p{margin:4px 0}
@media (max-width:640px){main{padding:24px 14px 56px}.who{min-width:0;display:inline}}
`;
