import { fit } from "./text.ts";

/**
 * canvas is lines made exactly width × height cells: short lines padded with
 * spaces, long ones cut, missing rows blank, extra rows dropped. Cells
 * without a style keep the terminal's own background, so a transparent
 * terminal stays transparent: the screen never paints one.
 */
export function canvas(lines: readonly string[], width: number, height: number): string[] {
  const blank = " ".repeat(Math.max(width, 0));
  return Array.from({ length: Math.max(height, 0) }, (_, i) => (i < lines.length ? fit(lines[i]!, width) : blank));
}
