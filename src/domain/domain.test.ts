import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobCurve } from "../core/types.ts";
import { linearOf, percentileOf, quantile } from "./baseline.ts";
import { perSecond } from "./metrics.ts";
import { buildPhaseWindows } from "./phases.ts";

const NAMES = ["P1", "P2", "P3", "P4"];

test("阶段切分丢弃被跳过的阶段", () => {
  // 从 P2 开打的 pull：P1 的转折点与 P2 同刻，长度为 0。
  const windows = buildPhaseWindows(
    [
      { id: 1, startTime: 1000 },
      { id: 2, startTime: 1000 },
      { id: 3, startTime: 3000 },
    ],
    5000,
    true,
    NAMES,
  );

  assert.deepEqual(
    windows.map((window) => window.index),
    [2, 3],
  );
  assert.equal(windows[0]?.durationMs, 2000);
});

test("团灭时最后一个阶段被判为未完成", () => {
  const wipe = buildPhaseWindows(
    [
      { id: 2, startTime: 0 },
      { id: 3, startTime: 2000 },
    ],
    2500,
    false,
    NAMES,
  );

  assert.equal(wipe[0]?.complete, true);
  assert.equal(wipe[1]?.complete, false);
});

test("通关时最后一个阶段算完成", () => {
  const kill = buildPhaseWindows([{ id: 2, startTime: 0 }], 2500, true, NAMES);
  assert.equal(kill[0]?.complete, true);
});

test("阶段名取自报告给出的名单", () => {
  const windows = buildPhaseWindows([{ id: 3, startTime: 0 }], 1000, true, NAMES);
  assert.equal(windows[0]?.name, "P3");
});

const CURVE: JobCurve = {
  job: "Dragoon",
  label: "龙骑士",
  sampleSize: 355,
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

test("分位在锚点上精确命中", () => {
  assert.equal(percentileOf(CURVE, 4000), 50);
  assert.equal(percentileOf(CURVE, 7000), 95);
});

test("分位在锚点之间线性插值", () => {
  assert.equal(percentileOf(CURVE, 4500), 62.5);
  assert.equal(percentileOf(CURVE, 2500), 17.5);
});

test("分位在两端被夹住", () => {
  assert.equal(percentileOf(CURVE, 1), 0);
  assert.equal(percentileOf(CURVE, 999_999), 100);
});

test("线性分按最低到最高归一", () => {
  assert.equal(linearOf(CURVE, 1000), 0);
  assert.equal(linearOf(CURVE, 9000), 100);
  assert.equal(linearOf(CURVE, 5000), 50);
});

test("取分位锚点", () => {
  assert.equal(quantile(CURVE, 50), 4000);
  assert.equal(quantile(CURVE, 100), 9000);
});

test("每秒数值以 combatTime 为除数，与官方排行榜一致", () => {
  // 取自幻想龙诗国服龙骑榜首的一次通关，官方公布 rDPS 为 7972.3369083851。
  const entry = { name: "无以异也", type: "Dragoon", total: 8_507_609, totalRDPS: 8_707_705.26481451 };
  const rdps = perSecond(entry, 1_092_240, "rdps");

  assert.ok(Math.abs(rdps - 7972.3369083851) < 1e-9, `实得 ${rdps}`);
});

test("缺少扩展字段时退回原始总量", () => {
  const entry = { name: "某人", type: "Sage", total: 1000 };
  assert.equal(perSecond(entry, 1000, "rdps"), 1000);
  assert.equal(perSecond(entry, 0, "rdps"), 0);
});
