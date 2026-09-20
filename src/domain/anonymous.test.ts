import assert from "node:assert/strict";
import { test } from "node:test";
import type { Baseline, JobCurve, Report } from "../core/types.ts";
import { buildScoreboard, type Sample } from "./scoring.ts";

const CURVE: JobCurve = {
  job: "Reaper",
  label: "钐镰客",
  sampleSize: 200,
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

function baselineWith(jobs: readonly string[]): Baseline {
  const curves: Record<string, JobCurve> = {};
  for (const job of jobs) curves[job] = { ...CURVE, job, label: job === "Reaper" ? "钐镰客" : "贤者" };

  return {
    zoneId: 59,
    encounterId: 1076,
    metric: "rdps",
    partition: 39,
    window: 84,
    difficulty: 100,
    size: 8,
    fetchedAt: "",
    phases: { "2": curves },
  };
}

const PHASE = {
  index: 2,
  name: "P2: King Thordan",
  start: 0,
  end: 100_000,
  durationMs: 100_000,
  complete: true,
} as const;

function sample(player: string, job: string, value: number): Sample {
  return { fightId: 1, phase: PHASE, player, job, value };
}

const REPORT = { code: "abc", title: "t", zoneName: "幻想龙诗绝境战", owner: "o", zoneId: 59, start: 0, fights: [] } as unknown as Report;

test("显式要求实名时显示的就是角色名", () => {
  const board = buildScoreboard(REPORT, baselineWith(["Reaper"]), [sample("某人", "Reaper", 4000)], {
    metric: "rdps",
    aggregate: "median",
    anonymous: false,
  });

  assert.equal(board.anonymous, false);
  assert.equal(board.players[0]?.display, "某人");
});

test("匿名模式把角色名换成职业名", () => {
  const board = buildScoreboard(REPORT, baselineWith(["Reaper"]), [sample("某人", "Reaper", 4000)], {
    metric: "rdps",
    aggregate: "median",
    anonymous: true,
  });

  assert.equal(board.anonymous, true);
  assert.equal(board.players[0]?.display, "钐镰客");
  // 角色名仍留在数据里，只是不往外显示。
  assert.equal(board.players[0]?.player, "某人");
});

test("同队两个同职业时补序号，不会两行同名", () => {
  const board = buildScoreboard(
    REPORT,
    baselineWith(["Reaper"]),
    [sample("甲", "Reaper", 5000), sample("乙", "Reaper", 3000)],
    { metric: "rdps", aggregate: "median", anonymous: true },
  );

  assert.deepEqual(
    board.players.map((player) => player.display),
    ["钐镰客 1", "钐镰客 2"],
  );
});

test("职业只有一个人时不加多余的序号", () => {
  const board = buildScoreboard(
    REPORT,
    baselineWith(["Reaper", "Sage"]),
    [sample("甲", "Reaper", 5000), sample("乙", "Sage", 3000)],
    { metric: "rdps", aggregate: "median", anonymous: true },
  );

  assert.deepEqual(
    board.players.map((player) => player.display).sort(),
    ["贤者", "钐镰客"],
  );
});
