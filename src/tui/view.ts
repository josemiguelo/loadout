import { configApplied, configDrifted, configUnknown, done, failed, installed, missing, pending, unknown } from "../core/coremodel/coremodel.ts";
import * as diff from "../core/diff/diff.ts";
import { VERSION } from "../version.ts";
import { type Binding, newBinding } from "./key.ts";
import * as style from "./style/index.ts";
import {
  answered,
  containsAll,
  driftedRows,
  type FleetLine,
  fleetLineName,
  FocusArea,
  heading,
  type HomeModel,
  type HomeSection,
  plural,
  RemoteKind,
  type RemoteLine,
  remoteLines,
  runes,
  Severity,
  theme,
} from "./homemodel.ts";
import type { Inspector } from "./inspect.ts";
import { type Dialog, DialogKind, paletteShown } from "./keys.ts";
import { type Item, listOf, sectionOf, snap, SubjectConfigs, subjectOf, SubjectFleet, SubjectPrograms, SubjectRemote, SubjectScripts, wrapWords } from "./lists.ts";
import { finishedPanel, runsNewestFirst } from "./runs.ts";

// The side-by-side layout needs this many columns (width only: a wide but
// short window keeps it); under it the screen is stacked, one page at a time
// (user decision).
export const wideMinWidth = 100;
export const sidebarWidth = 32;
/** logoRows is the sidebar brand's height (style.sidebarLogo). */
const logoRows = 1;
/** sidebarGap is the gutter between the sidebar and the main pane. */
const sidebarGap = 3;
/**
 * panelShare is the run panel's share of the main pane (percent), and
 * panelMin its fewest rows.
 */
const panelShare = 45;
const panelMin = 10;

/**
 * Layout is where everything sits on a w × h screen. Rows are absolute; the
 * main pane's columns start at mainX.
 */
export interface Layout {
  w: number;
  h: number;
  /**
   * wide is side by side; otherwise stacked: the breadcrumb and its rule
   * (rows 0, 1), then one page — home, the subject or the run — full width.
   */
  wide: boolean;
  mainX: number;
  mainW: number;
  sideX: number;
  /** pageY is the first row under the stacked layout's header (0 when wide). */
  pageY: number;
  titleY: number;
  filterY: number;
  headY: number;
  listY: number;
  listH: number;
  /** panelY is the run panel's title row; panelH counts it (0: no panel). */
  panelY: number;
  panelH: number;
  statusY: number;
}

/** termSize is the run panel's emulator size. */
export function termSize(l: Layout): [w: number, h: number] {
  return [Math.max(l.mainW, 10), Math.max(l.panelH - 1, 3)];
}

export function layout(m: HomeModel, panel: boolean): Layout {
  return layoutOf(m.width, m.height, panel, m.state.maximized);
}

export function layoutOf(w: number, h: number, panel: boolean, maximized: boolean): Layout {
  w = Math.max(w, 40);
  h = Math.max(h, 12);
  const l: Layout = {
    w,
    h,
    wide: w >= wideMinWidth,
    mainX: 1,
    mainW: 0,
    sideX: 0,
    pageY: 0,
    titleY: 0,
    filterY: 0,
    headY: 0,
    listY: 0,
    listH: 0,
    panelY: 0,
    panelH: 0,
    statusY: h - 1,
  };
  if (l.wide) {
    // The sidebar is on the left, the main pane right of it.
    l.sideX = 1;
    l.mainX = 1 + sidebarWidth + sidebarGap;
    l.mainW = w - 2 - sidebarWidth - sidebarGap;
    [l.titleY, l.filterY, l.headY, l.listY] = [0, 2, 3, 4];
  } else {
    l.mainW = w - 2;
    l.pageY = 2;
    [l.titleY, l.filterY, l.headY, l.listY] = [2, 3, 4, 5];
  }
  l.listH = l.statusY - l.listY;
  if (panel && !l.wide) {
    // The run page: the panel fills it; the list keeps its own page.
    l.panelY = l.titleY;
    l.panelH = l.statusY - l.titleY;
  } else if (panel) {
    if (maximized) {
      l.panelY = l.titleY;
      l.panelH = l.statusY - l.titleY;
      l.listH = 0;
    } else {
      l.panelH = Math.max(Math.trunc(((l.statusY - l.titleY) * panelShare) / 100), panelMin);
      l.panelH = Math.max(Math.min(l.panelH, l.statusY - l.listY - 1 - 3), 4);
      l.panelY = l.statusY - l.panelH;
      l.listH = Math.max(l.panelY - 1 - l.listY, 0);
    }
  }
  return l;
}

/**
 * screenLines is the whole frame: exactly height rows of width cells. frame
 * is the busy clock's.
 */
export function screenLines(m: HomeModel, frame: number): string[] {
  const t = theme(m);
  const l = layout(m, m.shown !== undefined);
  let out = l.wide ? wideLines(m, t, l, frame) : stackedLines(m, t, l, frame);
  // A notification floats at the bottom right, over the screen and above the
  // help line, which stays; a dialog sits over it.
  const card = m.toasts.card(t, l.w - 2);
  if (card !== null && card.length > 0) out = style.overlay(out, card, l.w - style.width(card[0]!) - 1, l.statusY - card.length);
  const d = m.state.dialog;
  if (d !== undefined) {
    const lines = dialogLines(m, t, d, l, frame);
    if (lines !== null && lines.length > 0) out = style.center(out, lines, l.w, l.h);
  }
  return out;
}

/** wideLines is the side-by-side frame: the sidebar, its rule, the main pane. */
function wideLines(m: HomeModel, t: style.Theme, l: Layout, frame: number): string[] {
  const main = mainLines(m, t, l, frame);
  const side = sideWindow(m, sideLines(m, t, sidebarWidth, frame, true), l.statusY, true);
  const blank = " ".repeat(l.w);
  // The areas are told apart by rules (user decision): a vertical one in the
  // gutter between the sidebar and the main pane, and, with the run panel, a
  // horizontal one above it that meets it in a ├.
  const gutter = " " + style.divider(t, "│") + " ";
  let rule = -1;
  if (m.shown !== undefined && !m.state.maximized && l.panelH > 0 && l.panelY - 1 > l.titleY) {
    rule = l.panelY - 1;
    main[rule] = style.divider(t, "─".repeat(l.mainW));
  }
  const out = new Array<string>(l.h);
  for (let y = 0; y < l.h; y++) {
    if (y === l.statusY) out[y] = statusLine(m, t, l.w);
    else {
      const g = y === rule ? " " + style.divider(t, "├─") : gutter;
      out[y] = " " + style.fit(at(side, y), sidebarWidth) + "\x1b[m" + g + style.fit(at(main, y), l.mainW) + "\x1b[m ";
    }
    if (out[y] === "") out[y] = blank;
  }
  return out;
}

/** Page is what the stacked layout shows: one page, the focused area's. */
export enum Page {
  /** Home is the sidebar's content, full width. */
  Home,
  /** Subject is the main pane: the subject's list, or the inspector. */
  Subject,
  /** Run is the run panel, the whole page. */
  Run,
}

/** page is the focused area's page. */
export function page(m: HomeModel): Page {
  if (m.state.focus === FocusArea.Sidebar) return Page.Home;
  if (m.state.focus === FocusArea.Terminal && m.shown !== undefined) return Page.Run;
  return Page.Subject;
}

/** stacked says the screen shows one page at a time (narrower than wideMinWidth). */
export function stacked(m: HomeModel): boolean {
  return !layout(m, false).wide;
}

/**
 * stackedLines is the stacked frame: the breadcrumb, a rule under it, then
 * the focused area's page, full width.
 */
function stackedLines(m: HomeModel, t: style.Theme, l: Layout, frame: number): string[] {
  let body: string[];
  switch (page(m)) {
    case Page.Home:
      body = new Array<string>(l.pageY).fill("");
      body.push(...sideWindow(m, sideLines(m, t, l.mainW, frame, false), l.statusY - l.pageY, false));
      break;
    case Page.Run:
      body = new Array<string>(l.statusY).fill("");
      panelLines(m, t, l, frame, body);
      break;
    default:
      body = mainLines(m, t, l, frame);
  }
  const out = new Array<string>(l.h);
  for (let y = 0; y < l.h; y++) {
    if (y === l.statusY) out[y] = statusLine(m, t, l.w);
    else if (y === 0) out[y] = " " + style.fit(breadcrumb(m, t, l.mainW), l.mainW) + "\x1b[m ";
    else if (y === 1) out[y] = " " + style.divider(t, "─".repeat(l.mainW)) + " ";
    else out[y] = " " + style.fit(at(body, y), l.mainW) + "\x1b[m ";
  }
  return out;
}

/**
 * breadcrumb is the stacked layout's header: where you are, the verdict
 * counts, and a run going on behind the page shown.
 */
function breadcrumb(m: HomeModel, t: style.Theme, width: number): string {
  const s = m.state;
  let crumbs: string[];
  const subject = sectionOf(s)?.subject ?? "";
  switch (page(m)) {
    case Page.Home:
      crumbs = [s.machine];
      break;
    case Page.Run:
      // Where it came from: the Runs list on the home page, or a subject.
      crumbs = s.runFromSidebar ? [s.machine, "run"] : [subject, "run"];
      break;
    default:
      crumbs = [subject];
      if (s.inspect !== undefined) crumbs.push("inspect", s.inspect.name);
  }
  const right: string[] = [];
  if (m.active !== undefined && page(m) !== Page.Run) right.push(style.fg(t.busy, style.GlyphRunning + " " + m.active.label));
  const [settled, open] = verdictCounts(m);
  right.push(style.fg(t.success, `${style.GlyphCheck}${settled}`) + " " + style.fg(t.warning, `${style.GlyphDot}${open}`));
  return style.breadcrumb(t, crumbs, right, width);
}

/** verdictCounts is how many subjects are settled and how many have work. */
export function verdictCounts(m: HomeModel): [settled: number, open: number] {
  let settled = 0;
  let open = 0;
  for (const section of m.state.sections) {
    if (section.neutral) continue;
    if (section.severity === Severity.Settled) settled++;
    else open++;
  }
  return [settled, open];
}

/**
 * sideWindow is the sidebar's lines from the first one height rows can show
 * with the selected entry in view (a short window, or many runs).
 */
function sideWindow(m: HomeModel, lines: string[], height: number, logo: boolean): string[] {
  return lines.slice(sideOffset(m, lines.length, height, logo));
}

/** sideOffset is the sidebar's first line shown in height rows. */
export function sideOffset(m: HomeModel, total: number, height: number, logo: boolean): number {
  const s = m.state;
  let selected = sideHead(logo) + s.subject;
  if (s.sideRun >= 0) selected = sideHead(logo) + s.sections.length + 3 + s.sideRun;
  return Math.min(Math.max(selected - height + 1, 0), Math.max(total - height, 0));
}

/**
 * sideHead is how many lines come before the sidebar's first subject:
 * (brand, blank,) machine, system, blank, section header, blank.
 */
export function sideHead(logo: boolean): number {
  return logo ? logoRows + 1 + 5 : 5;
}

function at(lines: readonly string[], y: number): string {
  return y >= 0 && y < lines.length ? (lines[y] ?? "") : "";
}

// ---------------------------------------------------------------- main pane

const subjectTitles: Record<string, string> = {
  [SubjectPrograms]: "Programs",
  [SubjectScripts]: "Scripts",
  [SubjectConfigs]: "Configs",
  [SubjectRemote]: "Remote",
  [SubjectFleet]: "Fleet",
};

/** mainLines is the main pane, rows 0 to the status bar, each mainW wide. */
function mainLines(m: HomeModel, t: style.Theme, l: Layout, frame: number): string[] {
  const s = m.state;
  const lines = new Array<string>(l.statusY).fill("");
  const section = sectionOf(s);
  if (section === undefined) return lines;
  if (l.wide && s.maximized && m.shown !== undefined) {
    panelLines(m, t, l, frame, lines);
    return lines;
  }
  let title = subjectTitles[section.subject] ?? "";
  let info = section.summary;
  if (s.inspect !== undefined) {
    title = "Inspect";
    info = s.inspect.name;
  } else if (section.busy) {
    info = style.busyLabel(t, frame, "checking…");
  }
  lines[l.titleY] = s.focus === FocusArea.Main ? style.titleRowFocused(t, title, info, l.mainW) : style.titleRowMuted(t, title, info, l.mainW);
  if (s.inspect !== undefined) {
    const body = inspectorLines(m, t, s.inspect, l.mainW);
    const height = l.listY + l.listH - l.filterY;
    const scroll = Math.min(s.inspect.scroll, Math.max(body.length - height, 0));
    for (let i = 0; i < height; i++) lines[l.filterY + i] = at(body, scroll + i);
  } else {
    lines[l.filterY] = filterLine(m, t, section.subject, l.mainW);
    if (section.subject === SubjectFleet) lines[l.headY] = fleetHeader(m, t, l.mainW - 1);
    listLines(m, t, l, section, frame, lines);
  }
  // Stacked, the run panel has its own page.
  if (l.wide && m.shown !== undefined) panelLines(m, t, l, frame, lines);
  return lines;
}

/** filterLine is the filter input: `> query` while typing, a hint otherwise. */
function filterLine(m: HomeModel, t: style.Theme, subject: string, _width: number): string {
  const query = m.state.filters.get(subject) ?? "";
  const prompt = style.fg(t.primary, "> ");
  if (m.state.filtering) return prompt + style.fg(t.fgBase, query) + style.fg(t.primary, "▏");
  if (query !== "") return prompt + style.fg(t.fgSubtle, query) + style.fg(t.fgMostSubtle, "  esc clears");
  return style.fg(t.fgMostSubtle, "> filter");
}

/** listLines draws the subject's list (and its scrollbar) into lines. */
function listLines(m: HomeModel, t: style.Theme, l: Layout, section: HomeSection, frame: number, lines: string[]): void {
  const s = m.state;
  if (l.listH <= 0) return;
  const items = listOf(s, section.subject);
  if (items.length === 0) {
    lines[l.listY] = " " + emptyLine(m, t, section, frame);
    return;
  }
  const cursor = snap(items, s.cursors.get(section.subject) ?? 0);
  let offset = Math.min(Math.max(s.offsets.get(section.subject) ?? 0, 0), Math.max(items.length - l.listH, 0));
  if (cursor >= 0) {
    offset = Math.min(offset, cursor);
    offset = Math.max(offset, cursor - l.listH + 1);
  }
  const bar = style.scrollbar(t, l.listH, items.length, l.listH, offset);
  const width = l.mainW - 1;
  const ctx = rowContextOf(m, width);
  for (let i = 0; i < l.listH; i++) {
    let row = "";
    const n = offset + i;
    if (n < items.length) {
      let focus = style.Focus.Unselected;
      if (n === cursor) focus = s.focus === FocusArea.Main ? style.Focus.SelectedFocused : style.Focus.SelectedBlurred;
      row = itemRow(m, t, section.subject, items[n]!, focus, width, ctx);
    }
    lines[l.listY + i] = style.fit(row, width) + at(bar, i);
  }
}

/** emptyLine is what an empty list says. */
function emptyLine(m: HomeModel, t: style.Theme, section: HomeSection, frame: number): string {
  const s = m.state;
  if (section.busy) return style.busyLabel(t, frame, "checking…");
  if (section.subject === SubjectRemote) {
    if (s.remote?.kind === "unavailable") return style.fg(t.error, "unavailable — " + s.remote.reason) + style.fg(t.fgMostSubtle, " · r asks again");
    if (s.remote === undefined) return style.fg(t.fgMostSubtle, "not asked yet — r asks");
  }
  if ((s.filters.get(section.subject) ?? "") !== "") return style.fg(t.fgMostSubtle, "nothing matches — esc clears the filter");
  return style.none(t);
}

/**
 * RowContext is what every row of a list lines up on, measured once a frame
 * from ALL its rows, not just the visible ones.
 */
interface RowContext {
  name: number;
  current: number;
  candidate: number;
  fleetName: number;
  fleetColumn: number;
}

function rowContextOf(m: HomeModel, width: number): RowContext {
  const s = m.state;
  const c: RowContext = { name: 0, current: 0, candidate: 0, fleetName: 0, fleetColumn: 0 };
  const longest = (names: readonly string[], fallback: number, limit: number) => {
    let n = fallback;
    for (const name of names) n = Math.max(n, runes(name));
    return Math.min(n, limit);
  };
  switch (subjectOf(s)) {
    case SubjectPrograms:
      c.name = longest(s.programs.map((p) => p.name), 8, 28) + 2;
      break;
    case SubjectScripts:
      c.name = longest(s.scripts.map((r) => r.name), 8, 28) + 2;
      break;
    case SubjectConfigs:
      c.name = longest(s.configs.map((r) => r.name), 8, 28) + 2;
      break;
    case SubjectRemote: {
      const ans = answered(s.remote);
      if (ans !== undefined) {
        // Versions get the room the terminal has: long java/sha strings fit
        // on a wide one and are clipped (head first) on a narrow one.
        const versionCap = width >= 100 ? 24 : 14;
        c.name = longest(ans.updates.map((r) => r.name), 8, 26) + 2;
        c.current = longest(ans.updates.map((r) => r.current), 1, versionCap) + 1;
        c.candidate = longest(ans.updates.map((r) => r.candidate), 1, versionCap) + 1;
      }
      break;
    }
    case SubjectFleet:
      c.fleetName = longest(driftedRows(s).map(fleetLineName), 8, 26) + 2;
      c.fleetColumn = 8;
      if (s.fleet !== undefined && s.fleet.machines.length > 0) {
        const machines = s.fleet.machines;
        c.fleetColumn = Math.max(Math.min(Math.trunc((width - 4 - c.fleetName) / machines.length), longest(machines, 6, 40) + 2), 8);
      }
      break;
  }
  return c;
}

/** itemRow is one list row of subject. */
function itemRow(m: HomeModel, t: style.Theme, subject: string, item: Item, focus: style.Focus, width: number, c: RowContext): string {
  const s = m.state;
  const name = (fg?: style.Color): style.Span => ({ text: column(item.name, c.name), fg, matches: item.matches });
  const sp = style.s;
  switch (subject) {
    case SubjectPrograms: {
      const p = s.programs[item.index]!;
      let tick = sp(" ");
      let glyph = style.statusGlyph(t, style.Status.Idle);
      let right = "not observed";
      switch (p.status) {
        case missing:
          tick = style.tick(t, s.chosen.has(p.name));
          glyph = style.statusGlyph(t, style.Status.Failed);
          right = "missing · via " + p.installKey;
          break;
        case installed:
          glyph = style.statusGlyph(t, style.Status.OK);
          right = p.version === "" ? "installed" : cutVersion(p.version, 24);
          break;
        case unknown:
          glyph = style.statusGlyph(t, style.Status.Attention);
          right = "not checked";
          break;
      }
      return style.listRow(t, [tick, sp(" "), glyph, sp(" "), name()], [sp(right)], focus, width);
    }
    case SubjectScripts: {
      const r = s.scripts[item.index]!;
      const [glyph, verdict] = scriptGlyph(t, r.status);
      return style.listRow(t, [style.tick(t, s.picked.has(r.name)), sp(" "), glyph, sp(" "), name(), sp(r.description, t.fgMostSubtle)], [sp(verdict)], focus, width);
    }
    case SubjectConfigs: {
      const r = s.configs[item.index]!;
      const [glyph, verdict] = configGlyph(t, r.status);
      return style.listRow(
        t,
        [style.tick(t, s.applying.has(r.name)), sp(" "), glyph, sp(" "), name(), sp(r.files.join(", "), t.fgMostSubtle)],
        [sp(verdict)],
        focus,
        width,
      );
    }
    case SubjectFleet:
      return fleetRow(m, t, driftedRows(s)[item.index]!, item, focus, width, c);
    case SubjectRemote: {
      const ans = answered(s.remote);
      if (ans === undefined) return "";
      return remoteRow(m, t, remoteLines(ans, s.collapsed)[item.index]!, item, focus, width, c);
    }
  }
  return "";
}

function scriptGlyph(t: style.Theme, status: string): [style.Span, string] {
  switch (status) {
    case done:
      return [style.statusGlyph(t, style.Status.OK), "done"];
    case pending:
      return [style.statusGlyph(t, style.Status.Pending), "pending"];
    case failed:
      return [style.statusGlyph(t, style.Status.Failed), "failed"];
  }
  return [style.statusGlyph(t, style.Status.Idle), "not observed"];
}

function configGlyph(t: style.Theme, status: string): [style.Span, string] {
  switch (status) {
    case configApplied:
      return [style.statusGlyph(t, style.Status.OK), "applied"];
    case configDrifted:
      return [style.statusGlyph(t, style.Status.Pending), "drifted"];
    case configUnknown:
      return [style.statusGlyph(t, style.Status.Attention), "not checked"];
  }
  return [style.statusGlyph(t, style.Status.Idle), "not observed"];
}

/**
 * cutVersion keeps a version's tail: versions differ at the END
 * ("adoptopenjdk-21.0.6+7" vs "…21.0.8+9"), so one that can't fit loses its
 * head.
 */
function cutVersion(text: string, width: number): string {
  const r = [...text];
  if (r.length <= width || width < 2) return text;
  return "…" + r.slice(r.length - (width - 1)).join("");
}

/**
 * remoteRow is one line of the remote tree, grouped by what will ACT: a tool
 * with everything it reported (ticking it means all of them), its declared
 * programs under it, a note for what else it would move; then each custom
 * source with its items, which tick alone.
 */
function remoteRow(m: HomeModel, t: style.Theme, line: RemoteLine, item: Item, focus: style.Focus, width: number, c: RowContext): string {
  const s = m.state;
  const sp = style.s;
  const tick = (key: string): style.Span => (key === "" ? sp("–", t.fgMostSubtle) : style.tick(t, s.selection.has(key)));
  // Only a group that hides something when folded shows a fold mark.
  const fold = (): style.Span => (!line.foldable ? sp(" ") : style.fold(t, !s.collapsed.has(line.group)));
  const name: style.Span = { text: item.name, matches: item.matches, bold: heading(line) };
  switch (line.kind) {
    case RemoteKind.Tool: {
      const tool = line.info;
      const updates = tool.total !== undefined ? `${tool.total} update${plural(tool.total)}` : "? updates";
      let what = "";
      let fg = t.warning;
      if (tool.total === undefined) what = `${tool.declared.length} in your loadout · others unknown`;
      else if (tool.total === 0) [what, fg] = ["up to date", t.successSubtle];
      else if (tool.declared.length === 0) what = updates + " · none in your loadout";
      else what = `${updates} · ${tool.declared.length} in your loadout`;
      return style.listRow(t, [fold(), sp(" "), tick(line.key), sp(" "), name, sp("  "), sp(what, fg)], [sp(tool.command ?? "")], focus, width);
    }
    case RemoteKind.Program:
    case RemoteKind.Item: {
      const row = line.row;
      const lead = line.kind === RemoteKind.Item ? [sp("  "), tick(line.key), sp(" ")] : [sp("    ")];
      let note = row.note;
      if (row.link !== undefined) note = (note + " ↗").trim();
      return style.listRow(
        t,
        [
          ...lead,
          sp(style.GlyphUp + " ", t.warning),
          { ...name, text: column(item.name, c.name) },
          sp(style.fit(cutVersion(row.current, c.current - 1), c.current), t.fgMoreSubtle),
          sp(style.GlyphArrow + " ", t.fgMostSubtle),
          sp(cutVersion(row.candidate, c.candidate - 1), t.warning),
        ],
        [sp(note)],
        focus,
        width,
      );
    }
    case RemoteKind.Others:
      return style.listRow(t, [sp("    "), sp(`${style.GlyphMore} ${line.names.length} more not in your loadout · enter lists them`, t.warning)], [], focus, width);
    case RemoteKind.Source: {
      const box = line.itemKeys.length > 0 ? style.tick(t, containsAll(s.selection, line.itemKeys)) : sp("–", t.fgMostSubtle);
      return style.listRow(t, [fold(), sp(" "), box, sp(" "), name], [], focus, width);
    }
  }
  return "";
}

/** fleetHeader is the fleet table's heading: which machine each column is. */
function fleetHeader(m: HomeModel, t: style.Theme, width: number): string {
  const s = m.state;
  if (s.fleet === undefined || driftedRows(s).length === 0) return "";
  const c = rowContextOf(m, width);
  let line = " ".repeat(1 + 2 + c.fleetName);
  for (const machine of s.fleet.machines) {
    const fg = machine === s.machine ? t.secondary : t.fgMoreSubtle;
    line += style.fg(fg, style.fit(style.truncate(machine, c.fleetColumn - 1), c.fleetColumn));
  }
  return line;
}

/** fleetRow is one drifting program or config, machines as columns. */
function fleetRow(m: HomeModel, t: style.Theme, line: FleetLine, item: Item, focus: style.Focus, width: number, c: RowContext): string {
  const s = m.state;
  const spans: style.Span[] = [];
  // A missing install is severe; version drift and a drifted config are not.
  if (line.program !== undefined && diff.incomplete(line.program)) spans.push(style.statusGlyph(t, style.Status.Failed));
  else spans.push(style.statusGlyph(t, style.Status.Pending));
  spans.push(style.s(" "), { text: column(item.name, c.fleetName), matches: item.matches });
  for (const machine of s.fleet!.machines) {
    let cell = "-";
    let fg = t.fgMostSubtle;
    if (line.program !== undefined) {
      const state = line.program.perMachine.get(machine) ?? { kind: diff.unknown };
      if (state.kind === diff.installed) [cell, fg] = [state.version ?? "ok", t.fgBase];
      else if (state.kind === diff.missing) [cell, fg] = ["missing", t.error];
    } else {
      const state = line.config!.perMachine.get(machine) ?? { kind: diff.configUnknown, files: 0 };
      if (state.kind === diff.configApplied) [cell, fg] = ["applied", t.fgBase];
      else if (state.kind === diff.configDrifted) [cell, fg] = ["drifted (" + state.files + ")", t.warning];
    }
    spans.push(style.s(style.fit(cutVersion(cell, c.fleetColumn - 1), c.fleetColumn), fg));
  }
  return style.listRow(t, spans, [], focus, width);
}

/** ExplainRowView is a label/value row as the inspector draws it. */
interface ExplainRowView {
  label: string;
  value: string;
  mine: string;
}

/**
 * inspectorLines is the inspector's body: explain's sections, then this
 * machine's verdict and the fleet's.
 */
export function inspectorLines(_m: HomeModel, t: style.Theme, inspector: Inspector, width: number): string[] {
  const out: string[] = [];
  const rows = (rows: readonly ExplainRowView[]) => {
    let labelW = 0;
    for (const r of rows) labelW = Math.max(labelW, runes(r.label));
    labelW = Math.min(labelW, 24);
    const valueW = Math.max(width - labelW - 4, 10);
    for (const r of rows) {
      let wrapped = wrapWords(r.value, valueW);
      if (wrapped.length === 0) wrapped = [""];
      wrapped.forEach((v, i) => {
        const label = i === 0 ? r.label : "";
        let line = "  " + style.fg(t.fgMoreSubtle, style.fit(label, labelW)) + "  " + style.fg(t.fgBase, v);
        if (i === wrapped.length - 1 && r.mine !== "") line += style.fg(t.secondary, "  ← " + r.mine);
        out.push(line);
      });
    }
  };
  if (inspector.err !== "") out.push(" " + style.fg(t.error, inspector.err), "");
  for (const item of inspector.items) {
    let head = " " + style.fg(t.primary, item.kind) + " " + style.renderSpan(t, { text: item.name, fg: t.fgBase, bold: true });
    if (item.description !== "" && item.kind !== "config") head += style.fg(t.fgMostSubtle, "  — " + item.description);
    out.push(head, "");
    const folder = item.folder === "" ? "the repo's root" : item.folder;
    const view: ExplainRowView[] = [{ label: "declared in", value: folder, mine: "" }];
    for (const r of item.rows) view.push({ label: r.label, value: r.value, mine: r.machine });
    rows(view);
    for (const note of item.notes) out.push("  " + style.fg(t.warning, note));
    out.push("");
  }
  const section = (title: string, r: ExplainRowView[]) => {
    out.push(style.section(t, title, "", width), "");
    if (r.length === 0) out.push("  " + style.none(t));
    rows(r);
    out.push("");
  };
  section(
    "This machine",
    inspector.machine.map((r) => ({ label: r.label, value: r.value, mine: "" })),
  );
  section(
    "Fleet",
    inspector.fleet.map((r) => ({ label: r.label, value: r.value, mine: "" })),
  );
  return out;
}

/**
 * panelLines draws the run panel into lines: its title row (the command, and
 * how it's going) and the emulator.
 */
function panelLines(m: HomeModel, t: style.Theme, l: Layout, _frame: number, lines: string[]): void {
  const r = m.shown;
  if (r === undefined || l.panelH <= 0) return;
  let info: string;
  switch (r.status()) {
    case "running":
      info = r.command + " " + style.fg(t.busy, style.GlyphRunning + " " + r.duration(m.now()));
      break;
    case "done":
      info = r.command + " " + style.fg(t.successSubtle, style.GlyphCheck + " done " + r.duration(m.now()));
      break;
    case "interrupted":
      info = r.command + " " + style.fg(t.attention, "interrupted");
      break;
    default:
      info = r.command + " " + style.fg(t.error, `${style.GlyphCross} exit ${r.code}`);
  }
  if (r.term !== undefined && r.term.scrolled() > 0) info = style.fg(t.fgMostSubtle, `↑${r.term.scrolled()} `) + info;
  lines[l.panelY] = m.state.focus === FocusArea.Terminal ? style.titleRowFocused(t, "Run", info, l.mainW) : style.titleRowMuted(t, "Run", info, l.mainW);
  if (r.term === undefined) return;
  r.term
    .view()
    .split("\n")
    .forEach((row, i) => {
      const y = l.panelY + 1 + i;
      if (y < l.statusY && i < l.panelH - 1) lines[y] = row + "\x1b[m";
    });
}

// ---------------------------------------------------------------- sidebar

/** sideLines is the sidebar (without logo: the stacked home page), each width wide. */
function sideLines(m: HomeModel, t: style.Theme, width: number, frame: number, logo: boolean): string[] {
  const s = m.state;
  const out: string[] = [];
  if (logo) out.push(...style.sidebarLogo(t, VERSION, width), "");
  out.push(style.fg(t.fgMoreSubtle, style.truncate(s.machine, width)), style.fg(t.fgMostSubtle, style.truncate(s.system, width)), "");
  out.push(style.section(t, "Machine", "", width), "");
  s.sections.forEach((section, i) => {
    let focus = style.Focus.Unselected;
    if (i === s.subject && s.sideRun < 0) focus = s.focus === FocusArea.Sidebar ? style.Focus.SelectedFocused : style.Focus.SelectedBlurred;
    out.push(style.subjectRow(t, sectionGlyph(t, section, frame), section.subject, section.short, focus, width));
  });
  out.push("", style.section(t, "Runs", "", width), "");
  const runs = runsNewestFirst(m);
  if (runs.length === 0) out.push("  " + style.none(t));
  runs.forEach((r, i) => {
    let focus = style.Focus.Unselected;
    if (i === s.sideRun) focus = s.focus === FocusArea.Sidebar ? style.Focus.SelectedFocused : style.Focus.SelectedBlurred;
    let glyph: string;
    let summary = r.duration(m.now());
    switch (r.status()) {
      case "running":
        glyph = style.renderSpan(t, style.statusGlyph(t, style.Status.Running));
        break;
      case "done":
        glyph = style.renderSpan(t, style.statusGlyph(t, style.Status.Done));
        break;
      case "interrupted":
        glyph = style.renderSpan(t, style.statusGlyph(t, style.Status.Interrupted));
        summary = "interrupted";
        break;
      default:
        glyph = style.renderSpan(t, style.statusGlyph(t, style.Status.Failed));
        summary = `exit ${r.code}`;
    }
    out.push(style.subjectRow(t, glyph, r.label, summary, focus, width));
  });
  return out;
}

/** sectionGlyph is a subject's status glyph, or its busy frame. */
function sectionGlyph(t: style.Theme, section: HomeSection, frame: number): string {
  if (section.busy) return style.busyGlyph(t, frame);
  if (section.neutral) return style.renderSpan(t, style.statusGlyph(t, style.Status.Idle));
  if (section.severity === Severity.Settled) return style.renderSpan(t, style.statusGlyph(t, style.Status.OK));
  if (section.severity === Severity.Attention) return style.renderSpan(t, style.statusGlyph(t, style.Status.Pending));
  return style.renderSpan(t, style.statusGlyph(t, style.Status.Failed));
}

// ---------------------------------------------------------------- status bar

function hb(keys: string, desc: string): Binding {
  return newBinding({ keys: [keys], help: [keys, desc] });
}

/** statusLine is the last row: the focused area's keys. */
function statusLine(m: HomeModel, t: style.Theme, width: number): string {
  return style.fit(style.helpLine(t, shortHelp(m), width), width);
}

/** shortHelp is the keys the focused area answers to. */
export function shortHelp(m: HomeModel): Binding[] {
  const s = m.state;
  const d = s.dialog;
  if (d !== undefined) {
    switch (d.kind) {
      case DialogKind.Confirm:
        return [hb("←→", "choose"), hb("enter", "press"), hb("y", "run"), hb("esc", "cancel")];
      case DialogKind.Palette:
        return [hb("↑↓", "choose"), hb("enter", "run"), hb("esc", "close")];
    }
    return [hb("↑↓", "scroll"), hb("esc", "close")];
  }
  if (s.filtering) return [hb("type", "filter"), hb("↑↓", "move"), hb("enter", "keep"), hb("esc", "clear")];
  const isStacked = stacked(m);
  switch (s.focus) {
    case FocusArea.Terminal: {
      const running = m.shown !== undefined && m.shown === m.active;
      if (running && isStacked) return [hb("ctrl+]", "back"), hb("ctrl+c", "interrupt"), hb("keys", "go to the command")];
      if (running) return [hb("ctrl+]", "dashboard"), hb("ctrl+c", "interrupt"), hb("keys", "go to the command")];
      if (isStacked) return [hb("↑↓", "scroll"), hb("pgup/pgdn", "page"), hb("gg/G", "start/end"), hb("esc", "back"), hb("q", "quit")];
      return [hb("↑↓", "scroll"), hb("pgup/pgdn", "page"), hb("gg/G", "start/end"), hb("z", "zoom"), hb("esc", "close"), hb("tab", "focus"), hb("q", "quit")];
    }
    case FocusArea.Sidebar:
      if (isStacked) return [hb("↑↓", "subject"), hb("enter/l", "open"), hb("ctrl+p", "commands"), hb("ctrl+g", "help"), hb("q", "quit")];
      if (finishedPanel(m)) {
        return [hb("↑↓", "subject"), hb("enter", "open the list"), hb("esc", "close run"), hb("tab", "focus"), hb("ctrl+p", "commands"), hb("ctrl+g", "help"), hb("q", "quit")];
      }
      return [hb("↑↓", "subject"), hb("enter/l", "open the list"), hb("tab", "focus"), hb("ctrl+p", "commands"), hb("ctrl+g", "help"), hb("q", "quit")];
  }
  if (s.inspect !== undefined) return [hb("↑↓", "scroll"), hb("esc", "back"), hb("ctrl+g", "help"), hb("q", "quit")];
  const subject = subjectOf(s);
  const verb = ({ [SubjectPrograms]: "install", [SubjectScripts]: "run", [SubjectConfigs]: "apply", [SubjectRemote]: "upgrade" } as Record<string, string>)[subject] ?? "";
  const b = [hb("↑↓", "move")];
  const filter = s.filters.get(subject) ?? "";
  if (isStacked && filter === "") b.push(hb("esc", "back"));
  else if (!isStacked && finishedPanel(m) && filter === "") b.push(hb("esc", "close run"));
  if (verb !== "") b.push(hb("space", "tick"), hb("a/u", "all/none"), hb("enter", verb));
  if (subject === SubjectRemote) b.push(hb("h/l", "fold"), hb("K", "page"));
  b.push(hb("/", "filter"), hb("i", "inspect"), hb("ctrl+p", "commands"), hb("ctrl+g", "help"), hb("q", "quit"));
  return b;
}

/**
 * fullHelp is ctrl+g's groups. Stacked, one page shows: no areas to tab
 * through, no run panel to zoom; esc and h go back a page.
 */
export function fullHelp(isStacked: boolean): Binding[][] {
  let move = hb("tab", "next area");
  let run = hb("z", "zoom the run");
  if (isStacked) {
    move = hb("esc h", "back a page");
    run = hb("enter l", "open a page");
  }
  return [
    [hb("↑↓ jk", "move"), hb("ctrl+d/u", "half page"), move, hb("1-5", "subject"), hb("/", "filter"), hb("i", "inspect"), hb("h/l", "fold, unfold"), hb("[ ]", "groups")],
    [
      hb("space", "tick"),
      hb("a / u", "all / none"),
      hb("enter", "act on the ticked rows"),
      hb("K", "open the row's page"),
      hb("r", "re-check"),
      hb("S", "sync"),
      hb("U", "upgrade loadout"),
      hb("C", "set up this machine"),
    ],
    [hb("ctrl+p", "commands"), hb("ctrl+]", "leave the terminal"), hb("ctrl+c", "interrupt the command"), run, hb("gg home / G end", "the run's start / end"), hb("t", "theme"), hb("q", "quit")],
  ];
}

// ---------------------------------------------------------------- dialogs

const confirmTitles: Record<number, string> = { 0: "Upgrade", 1: "Run scripts", 2: "Install", 3: "Apply" };

/** confirmIntro is a confirm dialog's first line. */
function confirmIntro(d: Dialog): string {
  if (d.title !== "") return "This runs:";
  switch (d.pane) {
    case 1:
      return "These scripts will run, in order:";
    case 2:
      return "These programs will install, in order:";
    case 3:
      return "These configs will be written from the repo:";
  }
  return "These will upgrade, in order:";
}

/** dialogLines is the dialog d, framed, for the screen in l. */
function dialogLines(m: HomeModel, t: style.Theme, d: Dialog, l: Layout, _frame: number): string[] | null {
  const maxH = Math.min(style.DialogMaxHeight, l.h - 2);
  let dl: style.Dialog;
  switch (d.kind) {
    case DialogKind.Confirm: {
      const title = d.title !== "" ? d.title : (confirmTitles[d.pane] ?? "");
      const limit = Math.min(style.DialogWideMaxWidth, l.w - 4) - 4;
      let longest = 0;
      for (const item of d.items) longest = Math.max(longest, runes(item.name));
      const col = Math.min(longest, 24) + 2;
      // As wide as the longest row wants, between a readable minimum and the cap.
      let width = runes(confirmIntro(d));
      for (const item of d.items) width = Math.max(width, col + runes(item.text) + "  · enter lists them".length + 2);
      width = Math.min(Math.max(width, 44), limit);
      const body: string[] = [];
      d.items.forEach((item, i) => {
        let text = item.text;
        let fg = t.fgMoreSubtle;
        if ((item.list?.length ?? 0) > 0) {
          fg = t.warning;
          text += "  · enter lists them";
        }
        const focus = i === d.row ? style.Focus.SelectedFocused : style.Focus.Unselected;
        let parts = wrapWords(text, Math.max(width - col - 2, 10));
        if (parts.length === 0) parts = [""];
        parts.forEach((part, j) => {
          const label = j === 0 ? item.name : "";
          body.push(style.listRow(t, [style.s(style.fit(style.truncate(label, col - 1), col), t.fgBase), style.s(part, fg)], [], focus, width));
        });
      });
      dl = {
        title,
        info: `${d.items.length} step${plural(d.items.length)}`,
        body: [style.fg(t.fgSubtle, confirmIntro(d)), "", ...scrolled(body, d.scroll, maxH - 10)],
        buttons: ["Run", "Cancel"],
        focused: d.cancelFocused ? 1 : 0,
        help: "←→ choose · enter press · y run · esc cancel",
        width,
        maxWidth: style.DialogWideMaxWidth,
      };
      break;
    }
    case DialogKind.List: {
      let body = d.lines.map((line) => style.fg(t.fgBase, line));
      body = scrolled(body, d.scroll, maxH - 10);
      if (d.summary !== "") body.push("", style.fg(t.fgMostSubtle, d.summary));
      dl = { title: d.title, info: String(d.lines.length), body, buttons: ["Close"], focused: 0, help: "↑↓ scroll · esc close" };
      break;
    }
    case DialogKind.Palette: {
      const width = Math.min(56, l.w - 8);
      const [shown, matches] = paletteShown(m.state, d.query);
      const body = [style.fg(t.primary, "> ") + style.fg(t.fgBase, d.query) + style.fg(t.primary, "▏"), ""];
      // The window follows the cursor.
      const visible = Math.max(maxH - 8, 3);
      const first = Math.max(d.cursor - visible + 1, 0);
      shown.forEach((e, i) => {
        if (i < first || i >= first + visible) return;
        const focus = i === d.cursor ? style.Focus.SelectedFocused : style.Focus.Unselected;
        body.push(style.listRow(t, [{ text: e.title, matches: matches[i] }], [style.s(e.keys, t.fgMoreSubtle)], focus, width));
      });
      if (shown.length === 0) body.push(" " + style.none(t));
      dl = { title: "Commands", body, help: "↑↓ choose · enter run · esc close", width };
      break;
    }
    case DialogKind.Help: {
      const width = Math.min(l.w - 8, 96);
      const body = style.fullHelp(t, fullHelp(!l.wide), width).split("\n");
      dl = { title: "Help", body: scrolled(body, d.scroll, maxH - 6), help: "esc close", width, maxWidth: 100 };
      break;
    }
  }
  return style.renderDialog(dl, t, l.w, l.h);
}

/** scrolled is lines from scroll on, at most height of them (height ≤ 0: all). */
function scrolled(lines: string[], scroll: number, height: number): string[] {
  if (height <= 0 || lines.length <= height) return lines;
  scroll = Math.min(Math.max(scroll, 0), lines.length - height);
  const out = lines.slice(scroll, scroll + height);
  const below = lines.length - scroll - height;
  if (below > 0) out[out.length - 1] = `  ↓ ${below} more`;
  return out;
}

/**
 * column is text in a column of width cells: cut with "…" so at least one
 * space separates it from the next column, padded otherwise.
 */
function column(text: string, width: number): string {
  return style.fit(style.truncate(text, width - 1), width);
}

/** resize takes the terminal's new size; the run panel's emulators follow. */
export function resize(m: HomeModel, w: number, h: number): void {
  m.width = w;
  m.height = h;
  resizeTerms(m);
}

export function resizeTerms(m: HomeModel): void {
  const [w, h] = termSize(layout(m, true));
  // A closed run (its emulator released, its text kept) resizes too: a run
  // reopened from Runs and zoomed must fill the zoomed panel.
  for (const r of [m.active, m.shown]) {
    if (r?.term === undefined) continue;
    const [cw, ch] = r.term.size();
    if (cw !== w || ch !== h) r.term.resize(w, h);
  }
}
