/** 终端输出原语：颜色、等宽对齐、表格。全部按显示宽度计算，中文按两格。 */

const enabled = (() => {
  if (process.env["NO_COLOR"]) return false;
  if (process.argv.includes("--no-color")) return false;
  return process.stdout.isTTY === true || process.env["FORCE_COLOR"] === "1";
})();

function wrap(open: number, close: number) {
  return (text: string): string => (enabled ? `\u001B[${open}m${text}\u001B[${close}m` : text);
}

/** 256 色前景，用来还原 FF Logs 的分位配色。 */
export function color(code: number): (text: string) => string {
  return (text: string): string => (enabled ? `\u001B[38;5;${code}m${text}\u001B[39m` : text);
}

export const style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

const ANSI = /\u001B\[[0-9;]*m/g;

/** 东亚宽字符占两格，其余占一格。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text.replace(ANSI, "")) {
    const code = char.codePointAt(0) ?? 0;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

export function padEnd(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

export function padStart(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - displayWidth(text))) + text;
}

export type Align = "left" | "right";

export interface Column {
  readonly header: string;
  readonly align?: Align;
}

/** 渲染一张对齐的表格。列宽取表头与内容的最大显示宽度。 */
export function table(columns: readonly Column[], rows: readonly (readonly string[])[]): string {
  const widths = columns.map((column, index) =>
    rows.reduce((max, row) => Math.max(max, displayWidth(row[index] ?? "")), displayWidth(column.header)),
  );

  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) =>
        columns[index]?.align === "right" ? padStart(cell, widths[index] ?? 0) : padEnd(cell, widths[index] ?? 0),
      )
      .join("  ")
      .trimEnd();

  const head = style.bold(line(columns.map((column) => column.header)));
  const rule = style.gray(widths.map((width) => "─".repeat(width)).join("  "));
  return [head, rule, ...rows.map(line)].join("\n");
}

export function heading(text: string): string {
  return `\n${style.bold(style.cyan(text))}`;
}
