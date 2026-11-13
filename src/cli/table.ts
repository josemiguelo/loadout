import { echo } from "./spinner.ts";
import { Style } from "./style.ts";

/**
 * TableRow is one printed row: usually a single line, plus any detail lines
 * under it. Severity undefined = settled, false = needs attention (warn),
 * true = severe (error).
 */
export interface TableRow {
  lines: string[];
  severity?: boolean;
}

/** attention is the severity of a row that needs attention (warn). */
export const attention = false;
/** severe is the severity of a severe row (error). */
export const severe = true;

const ansi = /\x1b\[[0-9;]*m/g;

/** runeCount is s's length in code points, as Go's utf8.RuneCountInString. */
export function runeCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** printedWidth is the visible width of a styled string — escape codes take no columns. */
export function printedWidth(text: string): number {
  return runeCount(text.replace(ansi, ""));
}

/** padEnd pads s with spaces to width characters, as Kotlin's padEnd does. */
export function padEnd(s: string, width: number): string {
  const n = runeCount(s);
  return n < width ? s + " ".repeat(width - n) : s;
}

/**
 * echoRows echoes table rows, wrapping the ones that need attention
 * (severity set) in a rounded box. Consecutive attention rows share one
 * box, so a run reads as a single block, and the box takes the severe colour
 * if any row in it is severe. Plain rows get the same two-column gutter the
 * border occupies, so columns line up either way.
 */
export function echoRows(rows: readonly TableRow[]): void {
  const paint = (isSevere: boolean, text: string) => (isSevere ? Style.error(text) : Style.warn(text));
  let width = 0;
  for (const row of rows) {
    if (row.severity === undefined) continue;
    for (const line of row.lines) width = Math.max(width, printedWidth(line));
  }
  let isSevere = false;
  rows.forEach((row, index) => {
    if (row.severity === undefined) {
      for (const line of row.lines) echo("  " + line);
      return;
    }
    if (index === 0 || rows[index - 1]!.severity === undefined) {
      isSevere = false;
      for (let i = index; i < rows.length && rows[i]!.severity !== undefined; i++) {
        isSevere = isSevere || rows[i]!.severity!;
      }
      echo(paint(isSevere, "╭" + "─".repeat(width + 2) + "╮"));
    }
    for (const line of row.lines) {
      const pad = " ".repeat(Math.max(width - printedWidth(line), 0));
      echo(paint(isSevere, "│") + " " + line + pad + " " + paint(isSevere, "│"));
    }
    if (index === rows.length - 1 || rows[index + 1]!.severity === undefined) {
      echo(paint(isSevere, "╰" + "─".repeat(width + 2) + "╯"));
    }
  });
}
