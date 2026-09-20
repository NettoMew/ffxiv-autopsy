import { OVERALL, type PhaseWindow } from "../core/types.ts";

interface RawPhase {
  readonly id: number;
  readonly startTime: number;
}

/**
 * 把报告给出的阶段转折点切成时间窗口。
 *
 * 两个容易踩的坑，都在这里处理掉：
 *   1. 从中途阶段开打的 pull，被跳过的阶段长度为 0，必须丢弃；
 *   2. 一次团灭的最后一个阶段是被截断的，拿它去和官方通关数据比毫无意义，
 *      因此标成未完成，只展示不计分。
 */
export function buildPhaseWindows(
  phases: readonly RawPhase[],
  fightStart: number,
  fightEnd: number,
  kill: boolean,
  names: readonly string[],
): PhaseWindow[] {
  const windows: PhaseWindow[] = [];

  // 通关的那把额外给一个整场窗口。统计页的 phase 0 就是整场，
  // 通关成绩本来就是大家最认的那个数，只按 P 拆开反而把它丢了。
  if (kill) {
    windows.push({
      index: OVERALL,
      name: "整场",
      start: fightStart,
      end: fightEnd,
      durationMs: fightEnd - fightStart,
      complete: true,
    });
  }

  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index];
    if (!phase) continue;

    const end = phases[index + 1]?.startTime ?? fightEnd;
    const durationMs = end - phase.startTime;
    if (durationMs <= 0) continue;

    const isLast = index === phases.length - 1;
    windows.push({
      index: phase.id,
      name: names[phase.id - 1] ?? `P${phase.id}`,
      start: phase.startTime,
      end,
      durationMs,
      complete: !isLast || kill,
    });
  }

  return windows;
}
