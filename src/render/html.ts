import { WINDOW_LABELS } from "../core/types.ts";
import { quantile } from "../domain/baseline.ts";
import type { PhaseScore, Scoreboard } from "../domain/scoring.ts";
import { bandOf, dateOf, duration, num, signedPercent } from "./format.ts";

/** 自包含的单文件报告，不引用任何外部资源，可以直接发给队友。 */
export function renderHtml(board: Scoreboard, host: string): string {
  const title = `${board.report.zoneName || board.report.title} 阶段评分`;

  const phaseIndices = [
    ...new Set(board.players.flatMap((player) => player.phases.map((phase) => phase.phaseIndex))),
  ].sort((a, b) => a - b);

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
  <header>
    <h1>${escape(board.report.zoneName || board.report.title)}</h1>
    <p class="subtitle">${escape(board.report.title)}</p>
    <dl class="meta">
      <div><dt>记录者</dt><dd>${escape(board.report.owner)}</dd></div>
      <div><dt>时间</dt><dd>${escape(dateOf(board.report.start))}</dd></div>
      <div><dt>口径</dt><dd>${escape(board.metricLabel)}</dd></div>
      <div><dt>官方窗口</dt><dd>${escape(WINDOW_LABELS[board.baseline.window])}</dd></div>
      <div><dt>分区</dt><dd>${board.baseline.partition}</dd></div>
      <div><dt>多次 pull</dt><dd>取${board.aggregate === "best" ? "最佳" : "中位"}值</dd></div>
      <div><dt>原始报告</dt><dd><a href="https://${escape(host)}/reports/${escape(board.report.code)}">${escape(board.report.code)}</a></dd></div>
    </dl>
  </header>

  <section>
    <h2>玩家总评</h2>
    <table>
      <thead><tr><th>玩家</th><th>职业</th><th class="n">分位</th><th class="n">线性</th><th>评级</th><th class="n">计分阶段</th><th>最强</th><th>最弱</th></tr></thead>
      <tbody>
${board.players
  .map((player) => {
    const rated = player.phases.filter((phase) => phase.percentile !== null);
    return `        <tr>
          <td class="name">${escape(player.player)}</td>
          <td>${escape(player.label)}</td>
          <td class="n">${score(player.percentile)}</td>
          <td class="n">${player.linear === null ? "—" : player.linear.toFixed(1)}</td>
          <td>${player.percentile === null ? "—" : escape(bandOf(player.percentile).name)}</td>
          <td class="n">${rated.length}</td>
          <td class="muted">${escape(player.strongest?.phaseName ?? "—")}</td>
          <td class="muted">${escape(player.weakest?.phaseName ?? "—")}</td>
        </tr>`;
  })
  .join("\n")}
      </tbody>
    </table>
  </section>

${phaseIndices.map((index) => phaseSection(board, index)).join("\n")}

${truncatedSection(board)}

  <footer>
    <p>分位来自 FF Logs 官方副本统计的同阶段同职业分布，线性分为 100 × (实测 − 最低) ÷ (最高 − 最低)。</p>
    <p>被团灭截断的阶段不与官方通关数据比较，因此不计分。</p>
  </footer>
</main>
</body>
</html>
`;
}

function phaseSection(board: Scoreboard, index: number): string {
  const rows = board.players
    .map((player) => ({ player, phase: player.phases.find((phase) => phase.phaseIndex === index) }))
    .filter((row) => row.phase !== undefined)
    .sort((a, b) => (b.phase?.percentile ?? -1) - (a.phase?.percentile ?? -1));

  const sample = rows[0]?.phase;
  if (!sample) return "";

  return `  <section>
    <h2>${escape(sample.phaseName)}</h2>
    <p class="subtitle">平均时长 ${escape(duration(sample.averageDurationMs))}</p>
    <table>
      <thead><tr><th>玩家</th><th>职业</th><th class="n">${escape(board.metricLabel)}</th><th class="n">最佳</th><th class="n">官方中位</th><th class="n">相对中位</th><th class="n">分位</th><th class="n">线性</th><th class="n">官方样本</th><th class="track-head">在官方分布中的位置</th></tr></thead>
      <tbody>
${rows
  .map(({ player, phase }) => {
    if (!phase) return "";
    return `        <tr>
          <td class="name">${escape(player.player)}</td>
          <td>${escape(player.label)}</td>
          <td class="n">${escape(num(phase.value))}</td>
          <td class="n">${escape(num(phase.best))}</td>
          <td class="n">${phase.curve ? escape(num(quantile(phase.curve, 50))) : "—"}</td>
          <td class="n ${phase.vsMedian !== null && phase.vsMedian >= 0 ? "up" : "down"}">${escape(signedPercent(phase.vsMedian))}</td>
          <td class="n">${phase.curve && !phase.reliable ? "<span class=\"muted\">样本不足</span>" : score(phase.percentile)}</td>
          <td class="n">${phase.linear === null ? "—" : phase.linear.toFixed(1)}</td>
          <td class="n muted">${phase.curve ? phase.curve.sampleSize : "—"}</td>
          <td>${track(phase)}</td>
        </tr>`;
  })
  .join("\n")}
      </tbody>
    </table>
  </section>`;
}

function truncatedSection(board: Scoreboard): string {
  if (board.truncated.length === 0) return "";

  return `  <section>
    <h2>未计分的阶段</h2>
    <p class="subtitle">被团灭截断，与官方通关数据不可比。</p>
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
  </section>`;
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
:root{color-scheme:dark;--bg:#12151b;--panel:#1a1f28;--line:#2b323e;--text:#dfe4ec;--muted:#8b94a5}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 20px 64px}
h1{margin:0;font-size:26px;letter-spacing:.5px}
h2{margin:0 0 4px;font-size:17px;font-weight:600}
header{border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:8px}
.subtitle{margin:2px 0 0;color:var(--muted);font-size:13px}
.meta{display:flex;flex-wrap:wrap;gap:8px 28px;margin:16px 0 0}
.meta div{display:flex;gap:8px}
.meta dt{margin:0;color:var(--muted)}
.meta dd{margin:0}
a{color:#6fb4ff}
section{margin-top:34px}
table{width:100%;border-collapse:collapse;margin-top:12px;font-variant-numeric:tabular-nums}
th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{color:var(--muted);font-weight:500;font-size:12px;letter-spacing:.4px}
tbody tr:hover{background:var(--panel)}
.n{text-align:right}
.name{font-weight:600}
.muted{color:var(--muted)}
.up{color:#5fd07a}
.down{color:#e2706a}
.track-head{width:200px}
.track{position:relative;display:block;width:180px;height:10px;border-radius:5px;background:#232a35}
.track .tick{position:absolute;top:1px;width:1px;height:8px;background:#3c4554}
.track .dot{position:absolute;top:0;width:10px;height:10px;margin-left:-5px;border-radius:50%}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
footer p{margin:4px 0}
`;
