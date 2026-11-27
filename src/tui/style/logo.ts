import { gradient, styledOr } from "./elements.ts";
import { fg, fit, GlyphCrumb, truncate, width } from "./text.ts";
import type { Theme } from "./theme.ts";

/** Name is the product name as the brand line writes it. */
export const Name = "loadout";

/**
 * sidebarLogo is the sidebar's brand line, exactly width cells: the name
 * bold in a Secondary→Primary gradient, the version at the right in
 * FgMostSubtle. Plain text: no block letters, no hatch. Narrow widths drop
 * the version first, then cut the name.
 */
export function sidebarLogo(t: Theme, version: string, w: number): string[] {
  if (w <= 0) return [""];
  const name = gradient(Name, t.secondary, t.primary, true);
  const nw = width(Name);
  if (w <= nw + 1 || version === "") return [fit(name, w)];
  version = truncate(version, w - nw - 1);
  const gap = w - nw - width(version);
  return [name + " ".repeat(gap) + fg(t.fgMostSubtle, version)];
}

/** oneLineLogo is the name alone, bold in a Secondary→Primary gradient, exactly width cells. */
export function oneLineLogo(t: Theme, w: number): string {
  if (w <= 0) return "";
  return fit(gradient(Name, t.secondary, t.primary, true), w);
}

/**
 * breadcrumb is the stacked layout's header row (user decision: a narrow
 * screen shows one page at a time, like a website's mobile view), exactly
 * width cells: `loadout › crumb › crumb` at the left — the name bold in the
 * brand gradient, the separators in Separator, the crumbs FgMoreSubtle but
 * the last, the page you're on, in FgBase — and right's parts (pre-styled,
 * or plain: FgMostSubtle) at the right, two cells apart. Parts that don't
 * fit are dropped from the end, then the crumbs are cut.
 */
export function breadcrumb(t: Theme, crumbs: readonly string[], right: readonly string[], w: number): string {
  if (w <= 0) return "";
  let left = gradient(Name, t.secondary, t.primary, true);
  const sep = fg(t.separator, " " + GlyphCrumb + " ");
  crumbs.forEach((c, i) => {
    left += sep + fg(i === crumbs.length - 1 ? t.fgBase : t.fgMoreSubtle, c);
  });
  const tail = (parts: readonly string[]): [string, number] => {
    const str = parts.map((p) => styledOr(p, t.fgMostSubtle)).join("  ");
    return [str, width(str)];
  };
  let [tailS, tailW] = tail(right);
  while (right.length > 0 && width(left) + 2 + tailW > w) {
    right = right.slice(0, -1);
    [tailS, tailW] = tail(right);
  }
  if (right.length === 0) return fit(left, w);
  return fit(left, w - tailW - 2) + "  " + tailS;
}
