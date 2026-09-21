import assert from "node:assert/strict";
import { test } from "node:test";
import type { Baseline, JobCurve, Report } from "../core/types.ts";
import { buildScoreboard, type Aggregate, type Sample } from "./scoring.ts";

const CURVE: JobCurve = {
  job: "Scholar",
  label: "学者",
  sampleSize: 800,
  points: [
    { q: 0, value: 1 },
    { q: 10, value: 2 },
    { q: 25, value: 3 },
    { q: 50, value: 4 },
    { q: 75, value: 5 },
    { q: 90, value: 6 },
    { q: 95, value: 7 },
    { q: 99, value: 8 },
    { q: 100, value: 100_000 },
  ],
};

const BASELINE = {
  zoneId: 59,
  encounterId: 1076,
  metric: "rdps",
  partition: 39,
  window: 84,
  windowLabel: "12 周范围",
  difficulty: 100,
  size: 8,
  fetchedAt: "",
  phases: { "3": { Scholar: CURVE } },
} as unknown as Baseline;

const PHASE = { index: 3, name: "P3", start: 0, end: 1000, durationMs: 1000, complete: true } as const;
const REPORT = { code: "c", title: "t", zoneName: "z", owner: "o", zoneId: 59, start: 0, fights: [] } as unknown as Report;

/** 取出代表值：只有一名玩家，所以直接看他那个 P 的结果。 */
function represent(values: readonly number[], how: Aggregate): number {
  const samples: Sample[] = values.map((value) => ({
    fightId: 1,
    phase: PHASE,
    player: "某人",
    job: "Scholar",
    value,
  }));

  const board = buildScoreboard(REPORT, BASELINE, samples, { metric: "rdps", aggregate: how, anonymous: true });
  return board.players[0]?.phases[0]?.value ?? Number.NaN;
}

test("只有一把时就是那一把", () => {
  assert.equal(represent([4200], "trimmed"), 4200);
});

test("两把时去不掉头尾，退回两把的平均", () => {
  assert.equal(represent([4000, 5000], "trimmed"), 4500);
});

test("三把和四把时去头尾等同于中位数", () => {
  assert.equal(represent([3000, 4000, 5000], "trimmed"), 4000);
  assert.equal(represent([3000, 4000, 5000], "median"), 4000);

  assert.equal(represent([3000, 4000, 5000, 6000], "trimmed"), 4500);
  assert.equal(represent([3000, 4000, 5000, 6000], "median"), 4500);
});

test("两端正好是极端值时，两种口径给出同一个数", () => {
  const values = [1000, 4000, 4100, 4200, 9000];
  assert.equal(represent(values, "median"), 4100);
  assert.equal(represent(values, "trimmed"), 4100);
});

test("成绩分成两簇时，去头尾平均看得见上限，中位数看不见", () => {
  // 取自真实日志：七把里有三把明显更好，中位数落在低的那一簇里。
  const values = [4021, 4053, 4083, 4121, 4560, 4676, 4910];

  assert.equal(represent(values, "median"), 4121);
  assert.equal(represent(values, "trimmed"), (4053 + 4083 + 4121 + 4560 + 4676) / 5);
  assert.ok(represent(values, "trimmed") > represent(values, "median"));
});

test("单次翻车被去掉，不会拖低成绩", () => {
  const values = [1540, 2800, 2850, 2900, 2950];
  assert.equal(represent(values, "trimmed"), (2800 + 2850 + 2900) / 3);
});

test("best 取最好的一把", () => {
  assert.equal(represent([4021, 4910, 4083], "best"), 4910);
});
