import { color, style } from "../core/terminal.ts";

/**
 * 分位配色沿用 FF Logs 自己的分段，看惯排行榜的人不需要重新建立直觉。
 */
export interface Band {
  readonly min: number;
  readonly name: string;
  readonly hex: string;
  readonly ansi: number;
}

export const BANDS: readonly Band[] = [
  { min: 100, name: "金", hex: "#E5CC80", ansi: 222 },
  { min: 99, name: "粉", hex: "#E268A8", ansi: 176 },
  { min: 95, name: "橙", hex: "#FF8000", ansi: 208 },
  { min: 75, name: "紫", hex: "#A335EE", ansi: 135 },
  { min: 50, name: "蓝", hex: "#0070FF", ansi: 33 },
  { min: 25, name: "绿", hex: "#1EFF00", ansi: 46 },
  { min: 0, name: "灰", hex: "#808080", ansi: 245 },
];

export function bandOf(percentile: number): Band {
  for (const band of BANDS) {
    if (percentile >= band.min) return band;
  }
  return BANDS[BANDS.length - 1] as Band;
}

export function paintPercentile(percentile: number | null): string {
  if (percentile === null) return style.gray("—");
  return color(bandOf(percentile).ansi)(percentile.toFixed(1));
}

export function num(value: number, digits = 0): string {
  return value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function signedPercent(ratio: number | null): string {
  if (ratio === null) return "—";
  const percent = ratio * 100;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`;
}

export function paintSigned(ratio: number | null): string {
  if (ratio === null) return style.gray("—");
  const text = signedPercent(ratio);
  return ratio >= 0 ? style.green(text) : style.red(text);
}

export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}分${String(seconds % 60).padStart(2, "0")}秒` : `${seconds}秒`;
}

export function dateOf(timestamp: number): string {
  if (!timestamp) return "未知";
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}
