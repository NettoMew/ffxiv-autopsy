import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobCurve } from "../core/types.ts";
import { buildInsights } from "./insights.ts";
import type { PhaseScore, PlayerScore, Scoreboard } from "./scoring.ts";

const CURVE: JobCurve = {
  job: "Sage",
  label: "贤者",
  sampleSize: 350,
  points: [
    { q: 0, value: 1000 },
    { q: 10, value: 2000 },
    { q: 25, value: 3000 },
    { q: 50, value: 4000 },
    { q: 75, value: 5000 },
    { q: 90, value: 6000 },
    { q: 95, value: 7000 },
    { q: 99, value: 8000 },
    { q: 100, value: 9000 },
  ],
};

function phase(overrides: Partial<PhaseScore> & { phaseName: string; percentile: number }): PhaseScore {
  return {
    phaseIndex: 2,
    pulls: 5,
    averageDurationMs: 100_000,
    value: 4000,
    best: 4200,
    worst: 3800,
    curve: CURVE,
    reliable: true,
    linear: 50,
    vsMedian: 0,
    ...overrides,
  };
}

function player(name: string, phases: PhaseScore[]): PlayerScore {
  const rated = phases.filter((item) => item.percentile !== null);
  const sorted = [...rated].sort((a, b) => (a.percentile ?? 0) - (b.percentile ?? 0));
  return {
    player: name,
    job: "Sage",
    display: name,
    label: "贤者",
    phases,
    overall: null,
    percentile: 50,
    linear: 50,
    strongest: sorted[sorted.length - 1] ?? null,
    weakest: sorted[0] ?? null,
  };
}

function board(players: PlayerScore[], truncated: Scoreboard["truncated"] = [], fights = 10): Scoreboard {
  return {
    report: { fights: Array.from({ length: fights }) } as unknown as Scoreboard["report"],
    metric: "rdps",
    metricLabel: "rDPS",
    aggregate: "median",
    anonymous: false,
    baseline: {} as Scoreboard["baseline"],
    samples: [],
    players,
    truncated,
  };
}

function textFor(name: string, insights: readonly { subject: string; text: string }[]): string {
  return insights
    .filter((insight) => insight.subject === name)
    .map((insight) => insight.text)
    .join(" ");
}

test("代表值低于官方最低值时判为严重", () => {
  const insights = buildInsights(
    board([player("甲", [phase({ phaseName: "P2", percentile: 0, value: 800, vsMedian: -0.8 })])]),
  );
  const first = insights.find((insight) => insight.subject === "甲");

  assert.equal(first?.severity, "critical");
  assert.match(first?.text ?? "", /比官方最低值 1,000 还低/);
});

test("落在后 10% 判为严重，后 25% 判为注意", () => {
  const low = buildInsights(board([player("乙", [phase({ phaseName: "P2", percentile: 6.9, vsMedian: -0.16 })])]));
  const mid = buildInsights(board([player("丙", [phase({ phaseName: "P2", percentile: 23.2, vsMedian: -0.05 })])]));

  assert.equal(low.find((insight) => insight.subject === "乙")?.severity, "critical");
  assert.equal(mid.find((insight) => insight.subject === "丙")?.severity, "warning");
});

test("最薄弱那一条在任何情况下都会输出", () => {
  const insights = buildInsights(board([player("丁", [phase({ phaseName: "P2", percentile: 88 })])]));
  assert.match(textFor("丁", insights), /最薄弱的是 P2/);
});

test("几把之间差得不多时不提", () => {
  const quiet = buildInsights(
    board([player("戊", [phase({ phaseName: "P2", percentile: 60, value: 4000, best: 4480, worst: 3520 })])]),
  );
  assert.doesNotMatch(textFor("戊", quiet), /差了 \d/);

  const loud = buildInsights(
    board([player("己", [phase({ phaseName: "P2", percentile: 60, value: 4000, best: 4700, worst: 3400 })])]),
  );
  assert.match(textFor("己", loud), /差了 32\.5%/);
});

test("不足三把时不谈稳定性", () => {
  const insights = buildInsights(
    board([player("庚", [phase({ phaseName: "P2", percentile: 60, pulls: 2, best: 5000, worst: 2000 })])]),
  );
  assert.doesNotMatch(textFor("庚", insights), /差了 \d/);
});

test("最好的 P 也不行时不说输出没问题", () => {
  const weak = buildInsights(
    board([
      player("辛", [
        phase({ phaseName: "P2", percentile: 6.9, phaseIndex: 2 }),
        phase({ phaseName: "P3", percentile: 35.6, phaseIndex: 3 }),
      ]),
    ]),
  );
  assert.match(textFor("辛", weak), /各 P 之间落差很大/);
  assert.doesNotMatch(textFor("辛", weak), /输出本身没问题/);

  const strong = buildInsights(
    board([
      player("壬", [
        phase({ phaseName: "P2", percentile: 21.1, phaseIndex: 2 }),
        phase({ phaseName: "P3", percentile: 95.1, phaseIndex: 3 }),
      ]),
    ]),
  );
  assert.match(textFor("壬", strong), /输出本身没问题/);
});

test("全队集体低于中位时升级为严重", () => {
  const players = [
    player("癸", [phase({ phaseName: "P2", percentile: 30, vsMedian: -0.05 })]),
    player("子", [phase({ phaseName: "P2", percentile: 40, vsMedian: -0.02 })]),
  ];
  const team = buildInsights(board(players)).find((insight) => insight.subject === "");

  assert.equal(team?.severity, "critical");
  assert.match(team?.text ?? "", /全部低于官方中位/);
});

test("团灭最多的 P 会被点出来", () => {
  const truncated = [
    { fightId: 1, phaseName: "P5", durationMs: 1000 },
    { fightId: 2, phaseName: "P5", durationMs: 1000 },
    { fightId: 3, phaseName: "P2", durationMs: 1000 },
  ];
  const insights = buildInsights(board([player("丑", [phase({ phaseName: "P2", percentile: 60 })])], truncated, 12));

  assert.match(
    insights.filter((insight) => insight.subject === "").map((insight) => insight.text).join(" "),
    /12 把里有 2 把倒在 P5/,
  );
});
