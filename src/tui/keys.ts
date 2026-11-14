import * as app from "../app/index.ts";
import * as style from "./style/index.ts";
import {
  answered,
  type Answered,
  containsAll,
  FocusArea,
  type HomeModel,
  namesSet,
  openInBrowser,
  type PaneItem,
  refresh,
  type RemoteLine,
  RemoteKind,
  link,
  heading,
  refusal,
  remoteLines,
  startConfigs,
  startInstalls,
  startScripts,
  startUpgrade,
  theme,
  toggled,
  withConfigs,
  withKeys,
  without,
  withValue,
} from "./homemodel.ts";
import { inspect } from "./inspect.ts";
import { fuzzy, type Item, listOf, sectionOf, snap, SubjectConfigs, subjectOf, SubjectFleet, SubjectPrograms, SubjectRemote, SubjectScripts } from "./lists.ts";
import { backFromRun, blurTerm, confirm, dismissRun, finishedPanel, interrupt, runsNewestFirst, showRun } from "./runs.ts";
import { layout, resizeTerms, stacked } from "./view.ts";

/** HomeKey is a key the screen answers to. */
export enum HomeKey {
  Up,
  Down,
  PageUp,
  PageDown,
  /** HalfUp and HalfDown are ctrl+u / ctrl+d: half a page, as in vim and less. */
  HalfUp,
  HalfDown,
  PrevHeading,
  NextHeading,
  Enter,
  /** Open is l/→: unfold, or go into the main pane. */
  Open,
  /** Close is h/←: fold, or back to the sidebar. */
  Close,
  Esc,
  Select,
  SelectAll,
  SelectNone,
  OpenLink,
  Refresh,
  Sync,
  Upgrade,
  Converge,
  Theme,
  Quit,
  Tab,
  ShiftTab,
  // Dialog buttons, gum's keys: y/n press one.
  Yes,
  No,
  Filter,
  Inspect,
  Palette,
  Help,
  /** Leave is ctrl+]: out of the terminal, back to the main pane. */
  Leave,
  /** Interrupt is ctrl+c outside the terminal. */
  Interrupt,
  /** Zoom is z: the run panel takes the whole main pane, or not. */
  Zoom,
  /**
   * Top and Bottom are home / end (and G): a finished run's output from its
   * start, or its end. G is g: twice in a row (gg) is Top, as in vim and
   * less.
   */
  Top,
  Bottom,
  G,
  Backspace,
  Subject1,
  Subject2,
  Subject3,
  Subject4,
  Subject5,
}

/** DialogKind is what a dialog is. */
export enum DialogKind {
  /** Confirm asks before a run: Run / Cancel. */
  Confirm,
  /**
   * List only lists (the "N more not in your loadout" packages, the files a
   * refusal names): Close.
   */
  List,
  /** Palette is ctrl+p's command palette. */
  Palette,
  /** Help is ctrl+g's full help. */
  Help,
}

/** Dialog is the overlay up: it owns the keyboard. */
export interface Dialog {
  kind: DialogKind;
  /** pane is a confirm's kind of command (it picks the title and intro). */
  pane: app.PaneKind;
  /** title is a list's or a machine-wide confirm's own title. */
  title: string;
  /**
   * items is a confirm's rows, in run order: what acts and what that means.
   * Never the commands: the run panel shows them.
   */
  items: PaneItem[];
  /** lines and summary are a list's lines and its note under them. */
  lines: string[];
  summary: string;
  /** scroll is the first body line shown. */
  scroll: number;
  /** cancelFocused says a confirm's focused button is Cancel, not Run. */
  cancelFocused: boolean;
  /** row is a confirm's selected row (-1: none, enter presses the button). */
  row: number;
  /** closed is what a confirm runs on yes. */
  closed: app.Closed;
  /** query and cursor are the palette's filter and selected entry. */
  query: string;
  cursor: number;
  /** parent is the dialog a list opened from comes back on close. */
  parent?: Dialog;
}

/** newDialog is a Dialog with every field not given at its default. */
export function newDialog(d: Partial<Dialog> & { kind: DialogKind }): Dialog {
  return {
    pane: app.PaneUpgrade,
    title: "",
    items: [],
    lines: [],
    summary: "",
    scroll: 0,
    cancelFocused: false,
    row: 0,
    closed: { action: app.ActionNone },
    query: "",
    cursor: 0,
    ...d,
  };
}

/** dialogAsking says the dialog asks a question (Run/Cancel). */
export function dialogAsking(d: Dialog): boolean {
  return d.kind === DialogKind.Confirm;
}

/** PaletteEntry is one command in the palette. */
export interface PaletteEntry {
  title: string;
  keys: string;
  key: HomeKey;
}

/** paletteEntries is the palette's commands for s, in order. */
export function paletteEntries(s: { sections: readonly { subject: string }[] }): PaletteEntry[] {
  const entries: PaletteEntry[] = [
    { title: "Re-check this machine", keys: "r", key: HomeKey.Refresh },
    { title: "Sync", keys: "S", key: HomeKey.Sync },
    { title: "Upgrade loadout", keys: "U", key: HomeKey.Upgrade },
    { title: "Set up this machine", keys: "C", key: HomeKey.Converge },
    { title: "Toggle theme", keys: "t", key: HomeKey.Theme },
  ];
  s.sections.forEach((section, i) => {
    if (i < 5) entries.push({ title: "Go to " + section.subject, keys: String(i + 1), key: HomeKey.Subject1 + i });
  });
  entries.push(
    { title: "Inspect the selected row", keys: "i", key: HomeKey.Inspect },
    { title: "Filter the list", keys: "/", key: HomeKey.Filter },
    { title: "Help", keys: "ctrl+g", key: HomeKey.Help },
    { title: "Quit", keys: "q", key: HomeKey.Quit },
  );
  return entries;
}

/** paletteShown is the palette's entries its query keeps, with the matches. */
export function paletteShown(s: { sections: readonly { subject: string }[] }, query: string): [PaletteEntry[], number[][]] {
  const shown: PaletteEntry[] = [];
  const matches: number[][] = [];
  for (const e of paletteEntries(s)) {
    const [at, ok] = fuzzy(query, e.title);
    if (ok) {
      shown.push(e);
      matches.push(at);
    }
  }
  return [shown, matches];
}

// ---------------------------------------------------------------- toasts

/** say is a toast: what a key did, or why it did nothing. */
export function say(m: HomeModel, kind: style.ToastKind, message: string): void {
  m.cmds.push(m.toasts.show(kind, message));
}

export function hey(m: HomeModel, message: string): void {
  say(m, style.ToastKind.Hey, message);
}
export function okay(m: HomeModel, message: string): void {
  say(m, style.ToastKind.OK, message);
}
export function warn(m: HomeModel, message: string): void {
  say(m, style.ToastKind.Warning, message);
}
export function fail(m: HomeModel, message: string): void {
  say(m, style.ToastKind.Error, message);
}

/** message is the toast showing ("" for none). */
export function message(m: HomeModel): string {
  if (!m.toasts.active()) return "";
  return m.toasts.message()[1];
}

// ---------------------------------------------------------------- reducers

/** handleKey is the reducer for one key (keys the terminal took never get here). */
export function handleKey(m: HomeModel, k: HomeKey): void {
  // gg is two keys: any other key in between disarms the first g.
  if (k !== HomeKey.G) m.gArmed = false;
  const s = m.state;
  if (s.dialog !== undefined) {
    dialogKey(m, k);
    return;
  }
  if (s.filtering) {
    filterKey(m, k);
    return;
  }
  // Keys that mean the same in every area.
  switch (k) {
    case HomeKey.Palette:
      s.dialog = newDialog({ kind: DialogKind.Palette });
      return;
    case HomeKey.Help:
      s.dialog = newDialog({ kind: DialogKind.Help });
      return;
    case HomeKey.Theme:
      toggleTheme(m);
      return;
    case HomeKey.Quit:
      if (m.active !== undefined || m.waiting !== undefined) warn(m, "a command is running — ctrl+c stops it, or wait");
      else s.exit = true;
      return;
    // Ctrl-C by reflex must not kill the screen: q quits. With a command
    // running, it stops the command, as in its terminal.
    case HomeKey.Interrupt:
      if (m.active !== undefined) interrupt(m);
      else hey(m, "q quits");
      return;
    case HomeKey.Sync:
      askMachine(m, app.ActionSync);
      return;
    case HomeKey.Upgrade:
      askMachine(m, app.ActionUpgrade);
      return;
    case HomeKey.Converge:
      askMachine(m, app.ActionSetup);
      return;
    case HomeKey.Refresh:
      if (m.active !== undefined || m.waiting !== undefined) hey(m, "checks wait for the command to finish");
      else refresh(m, true);
      return;
    // Stacked, one page shows: there is no other area to tab to.
    case HomeKey.Tab:
    case HomeKey.ShiftTab:
      if (!stacked(m)) cycleFocus(m, k === HomeKey.Tab);
      return;
    case HomeKey.Leave:
      if (s.focus === FocusArea.Terminal) {
        s.focus = FocusArea.Main;
        blurTerm(m);
      }
      return;
    // Stacked, the run page is already the whole screen.
    case HomeKey.Zoom:
      if (m.shown !== undefined && !stacked(m)) {
        s.maximized = !s.maximized;
        resizeTerms(m);
      }
      return;
  }
  if (k >= HomeKey.Subject1 && k <= HomeKey.Subject5) {
    const i = k - HomeKey.Subject1;
    if (i < s.sections.length) {
      showSubject(m, i);
      // Stacked, the subject's page shows, from any page.
      if (stacked(m)) focus(m, FocusArea.Main);
    }
    return;
  }
  switch (s.focus) {
    case FocusArea.Sidebar:
      sidebarKey(m, k);
      break;
    case FocusArea.Main:
      mainKey(m, k);
      break;
    case FocusArea.Terminal:
      terminalKey(m, k);
      break;
  }
}

/**
 * handleText is typed text while an input has the keyboard (the filter, the
 * palette's query).
 */
export function handleText(m: HomeModel, text: string): void {
  const s = m.state;
  if (s.dialog !== undefined && s.dialog.kind === DialogKind.Palette) {
    s.dialog = { ...s.dialog, query: s.dialog.query + text, cursor: 0 };
  } else if (s.filtering) {
    const subject = subjectOf(s);
    s.filters = withValue(s.filters, subject, (s.filters.get(subject) ?? "") + text);
    s.cursors = withValue(s.cursors, subject, 0);
    s.offsets = withValue(s.offsets, subject, 0);
  }
}

/** typing says typed text goes to an input rather than to keys. */
export function typing(m: HomeModel): boolean {
  const s = m.state;
  return (s.dialog !== undefined && s.dialog.kind === DialogKind.Palette) || (s.dialog === undefined && s.filtering);
}

function toggleTheme(m: HomeModel): void {
  m.state.dark = !m.state.dark;
  const t = theme(m);
  for (const r of m.runs) {
    if (r.term !== undefined && !r.released) r.term.setColors(t.fgBase, t.bgBase);
  }
}

/** showSubject shows subject i in the main pane. */
export function showSubject(m: HomeModel, i: number): void {
  const s = m.state;
  if (i !== s.subject) s.inspect = undefined;
  s.subject = i;
  s.sideRun = -1;
}

/**
 * cycleFocus moves the focus to the next area (sidebar, main, terminal while
 * the run panel shows), or the previous one.
 */
function cycleFocus(m: HomeModel, forward: boolean): void {
  const areas = [FocusArea.Sidebar, FocusArea.Main];
  if (m.shown !== undefined) areas.push(FocusArea.Terminal);
  let i = areas.indexOf(m.state.focus);
  i = forward ? (i + 1) % areas.length : (i - 1 + areas.length) % areas.length;
  focus(m, areas[i]!);
}

export function focus(m: HomeModel, area: FocusArea): void {
  m.state.focus = area;
  if (area === FocusArea.Terminal && m.shown?.term !== undefined) m.shown.term.focus();
  else blurTerm(m);
}

/** askMachine asks before a machine-wide verb: sync, upgrading loadout, set-up. */
function askMachine(m: HomeModel, action: app.HomeAction): void {
  if (m.active !== undefined || m.waiting !== undefined) {
    hey(m, "a command is running — wait for it or ctrl+c it");
    return;
  }
  const d = newDialog({ kind: DialogKind.Confirm, row: -1, closed: { action } });
  switch (action) {
    case app.ActionSync:
      d.title = "Sync";
      d.items = [
        { name: "pull", text: "the config repo's latest (and its parent's)" },
        { name: "apply", text: "configs that changed" },
        { name: "check", text: "this machine's programs, scripts and configs" },
        { name: "push", text: "this machine's state, committed" },
      ];
      if (!withConfigs(m)) d.items.splice(1, 1);
      break;
    case app.ActionUpgrade:
      d.title = "Upgrade loadout";
      d.items = [{ name: "self-upgrade", text: "installs the latest release; the screen ends afterwards" }];
      break;
    case app.ActionSetup:
      d.title = "Set up";
      d.items = [{ name: "setup-new-machine", text: "installs what's missing and runs the setup scripts; it shows its plan and asks first" }];
      break;
  }
  m.state.dialog = d;
}

/**
 * ask asks before touching anything: these commands change the machine, and
 * sweeps change more than the picked rows.
 */
export function ask(m: HomeModel, handoff: app.Handoff, items: PaneItem[]): void {
  m.state.dialog = newDialog({
    kind: DialogKind.Confirm,
    pane: handoff.kind,
    items,
    row: -1,
    closed: { action: app.ActionHandOff, handoff },
  });
}

/** dialogKey is a key while a dialog is up. */
function dialogKey(m: HomeModel, k: HomeKey): void {
  const s = m.state;
  const d: Dialog = { ...s.dialog! };
  const closeIt = () => {
    s.dialog = d.parent;
  };
  const page = Math.max(Math.trunc(m.height / 2), 3);
  const scroll = (delta: number) => {
    d.scroll = Math.max(d.scroll + delta, 0);
    s.dialog = d;
  };
  switch (d.kind) {
    case DialogKind.Confirm:
      switch (k) {
        case HomeKey.Esc:
        case HomeKey.Quit:
        case HomeKey.No:
          s.dialog = undefined;
          break;
        case HomeKey.Yes:
          confirm(m, d.closed);
          break;
        case HomeKey.Enter:
          if (d.row >= 0 && d.row < d.items.length && (d.items[d.row]!.list?.length ?? 0) > 0) {
            const item = d.items[d.row]!;
            s.dialog = newDialog({ kind: DialogKind.List, title: "Not in your loadout", lines: item.list!, summary: "These upgrade too.", parent: d });
          } else if (d.cancelFocused) {
            s.dialog = undefined;
          } else {
            confirm(m, d.closed);
          }
          break;
        case HomeKey.Open:
        case HomeKey.Close:
        case HomeKey.Tab:
        case HomeKey.ShiftTab:
          d.cancelFocused = !d.cancelFocused;
          s.dialog = d;
          break;
        case HomeKey.Up:
        case HomeKey.Down: {
          // Only list rows are stops: the others have nothing to open.
          const stops: number[] = [];
          d.items.forEach((item, i) => {
            if ((item.list?.length ?? 0) > 0) stops.push(i);
          });
          if (stops.length === 0) {
            scroll(k === HomeKey.Up ? -1 : 1);
            return;
          }
          const at = stops.indexOf(d.row);
          if (k === HomeKey.Down && at < stops.length - 1) d.row = stops[at + 1]!;
          else if (k === HomeKey.Up && at > 0) d.row = stops[at - 1]!;
          else if (k === HomeKey.Up) d.row = -1;
          s.dialog = d;
          break;
        }
        case HomeKey.PageUp:
          scroll(-page);
          break;
        case HomeKey.PageDown:
          scroll(page);
          break;
        case HomeKey.Theme:
          toggleTheme(m);
          break;
      }
      break;
    case DialogKind.List:
    case DialogKind.Help:
      switch (k) {
        case HomeKey.Esc:
        case HomeKey.Quit:
        case HomeKey.Enter:
        case HomeKey.No:
        case HomeKey.Yes:
          closeIt();
          break;
        case HomeKey.Help:
          if (d.kind === DialogKind.Help) closeIt();
          break;
        case HomeKey.Up:
          scroll(-1);
          break;
        case HomeKey.Down:
          scroll(1);
          break;
        case HomeKey.PageUp:
          scroll(-page);
          break;
        case HomeKey.PageDown:
          scroll(page);
          break;
        case HomeKey.Theme:
          toggleTheme(m);
          break;
      }
      break;
    case DialogKind.Palette: {
      const [shown] = paletteShown(s, d.query);
      switch (k) {
        case HomeKey.Esc:
        case HomeKey.Palette:
          s.dialog = undefined;
          break;
        case HomeKey.Up:
          d.cursor = Math.max(d.cursor - 1, 0);
          s.dialog = d;
          break;
        case HomeKey.Down:
          d.cursor = Math.min(d.cursor + 1, Math.max(shown.length - 1, 0));
          s.dialog = d;
          break;
        case HomeKey.Backspace: {
          const r = [...d.query];
          if (r.length > 0) {
            d.query = r.slice(0, -1).join("");
            d.cursor = 0;
          }
          s.dialog = d;
          break;
        }
        case HomeKey.Enter:
          s.dialog = undefined;
          if (d.cursor < shown.length) {
            const key = shown[d.cursor]!.key;
            if (key === HomeKey.Inspect || key === HomeKey.Filter) focus(m, FocusArea.Main);
            handleKey(m, key);
          }
          break;
      }
      break;
    }
  }
}

/**
 * filterKey is a key while the filter input has the keyboard: typing goes to
 * handleText; the arrows still move the list.
 */
function filterKey(m: HomeModel, k: HomeKey): void {
  const s = m.state;
  const subject = subjectOf(s);
  switch (k) {
    case HomeKey.Esc:
      s.filtering = false;
      s.filters = withValue(s.filters, subject, "");
      break;
    case HomeKey.Enter:
    case HomeKey.Tab:
      s.filtering = false;
      break;
    case HomeKey.Backspace: {
      const r = [...(s.filters.get(subject) ?? "")];
      if (r.length > 0) {
        s.filters = withValue(s.filters, subject, r.slice(0, -1).join(""));
        s.cursors = withValue(s.cursors, subject, 0);
      } else {
        s.filtering = false;
      }
      break;
    }
    case HomeKey.Up:
    case HomeKey.Down:
    case HomeKey.PageUp:
    case HomeKey.PageDown:
      mainKey(m, k);
      break;
  }
}

/**
 * sidebarKey is a key while the sidebar has the focus: the subjects, then
 * this session's runs.
 */
export function sidebarKey(m: HomeModel, k: HomeKey): void {
  const s = m.state;
  const runs = runsNewestFirst(m);
  switch (k) {
    case HomeKey.Up:
      if (s.sideRun > 0) s.sideRun--;
      else if (s.sideRun === 0) s.sideRun = -1;
      else if (s.subject > 0) showSubject(m, s.subject - 1);
      break;
    case HomeKey.Down:
      if (s.sideRun >= 0) s.sideRun = Math.min(s.sideRun + 1, runs.length - 1);
      else if (s.subject < s.sections.length - 1) showSubject(m, s.subject + 1);
      else if (runs.length > 0) s.sideRun = 0;
      break;
    case HomeKey.Open:
      if (s.sideRun >= 0 && s.sideRun < runs.length) {
        showRun(m, runs[s.sideRun]!);
        s.runFromSidebar = true;
        focus(m, FocusArea.Terminal);
      } else {
        focus(m, FocusArea.Main);
      }
      break;
    case HomeKey.Enter:
      if (s.sideRun >= 0 && s.sideRun < runs.length) {
        showRun(m, runs[s.sideRun]!);
        s.runFromSidebar = true;
        focus(m, FocusArea.Terminal);
        return;
      }
      // Enter on a subject goes INTO its list, like l: acting is the list's
      // enter, on what is ticked there (user decision) — never a command
      // started from a row whose ticks aren't in view.
      focus(m, FocusArea.Main);
      break;
    case HomeKey.Esc:
    case HomeKey.Close:
      if (k === HomeKey.Esc) {
        // Stacked, the run panel isn't on the home page: nothing to close.
        if (finishedPanel(m) && !stacked(m)) dismissRun(m);
        else hey(m, "nothing to close — q quits");
      }
      break;
    case HomeKey.Select:
    case HomeKey.SelectAll:
    case HomeKey.SelectNone:
    case HomeKey.Filter:
    case HomeKey.Inspect:
    case HomeKey.OpenLink:
      // They act on the main pane's list: go there and do it.
      if (s.sideRun < 0) {
        focus(m, FocusArea.Main);
        mainKey(m, k);
      }
      break;
  }
}

/**
 * terminalKey is a key on the run panel while its command isn't running (a
 * running one takes every key but ctrl+]): scroll its output, or close it.
 */
function terminalKey(m: HomeModel, k: HomeKey): void {
  const r = m.shown;
  if (r?.term === undefined) {
    focus(m, FocusArea.Main);
    return;
  }
  const t = r.term;
  switch (k) {
    case HomeKey.Up:
      t.scrollUp(1);
      break;
    case HomeKey.Down:
      t.scrollDown(1);
      break;
    case HomeKey.PageUp:
      t.pageUp();
      break;
    case HomeKey.PageDown:
      t.pageDown();
      break;
    case HomeKey.Top:
      t.top();
      break;
    case HomeKey.Bottom:
      t.bottom();
      break;
    case HomeKey.G:
      if (m.gArmed) t.top();
      m.gArmed = !m.gArmed;
      break;
    case HomeKey.HalfUp:
      t.scrollUp(Math.max(Math.trunc(t.size()[1] / 2), 1));
      break;
    case HomeKey.HalfDown:
      t.scrollDown(Math.max(Math.trunc(t.size()[1] / 2), 1));
      break;
    case HomeKey.Esc:
      dismissRun(m);
      break;
    case HomeKey.Close:
      focus(m, backFromRun(m));
      break;
  }
}

/** mainKey is a key while the main pane has the focus. */
export function mainKey(m: HomeModel, k: HomeKey): void {
  const s = m.state;
  if (s.inspect !== undefined) {
    const inspector = { ...s.inspect };
    switch (k) {
      case HomeKey.Esc:
      case HomeKey.Close:
      case HomeKey.Inspect:
        s.inspect = undefined;
        break;
      case HomeKey.Up:
        inspector.scroll = Math.max(inspector.scroll - 1, 0);
        break;
      case HomeKey.Down:
        inspector.scroll++;
        break;
      case HomeKey.PageUp:
        inspector.scroll = Math.max(inspector.scroll - listHeight(m), 0);
        break;
      case HomeKey.PageDown:
        inspector.scroll += listHeight(m);
        break;
      case HomeKey.HalfUp:
        inspector.scroll = Math.max(inspector.scroll - halfPage(m), 0);
        break;
      case HomeKey.HalfDown:
        inspector.scroll += halfPage(m);
        break;
    }
    if (s.inspect !== undefined) s.inspect = inspector;
    return;
  }
  const section = sectionOf(s);
  if (section === undefined) return;
  const subject = section.subject;
  const items = listOf(s, subject);
  const at = snap(items, s.cursors.get(subject) ?? 0);
  const item: Item | undefined = at >= 0 ? items[at] : undefined;
  const ans = answered(s.remote);
  const remoteLine = (): RemoteLine | undefined => {
    if (ans === undefined || item === undefined || subject !== SubjectRemote) return undefined;
    return remoteLines(ans, s.collapsed)[item.index];
  };
  switch (k) {
    case HomeKey.Up:
      moveCursor(m, -1);
      break;
    case HomeKey.Down:
      moveCursor(m, 1);
      break;
    case HomeKey.PageUp:
      moveCursor(m, -listHeight(m));
      break;
    case HomeKey.PageDown:
      moveCursor(m, listHeight(m));
      break;
    case HomeKey.HalfUp:
      moveCursor(m, -halfPage(m));
      break;
    case HomeKey.HalfDown:
      moveCursor(m, halfPage(m));
      break;
    // Over the rows to the next thing that heads a run of them: a group of
    // the remote tree. A page is a distance; this is a structure.
    case HomeKey.PrevHeading:
    case HomeKey.NextHeading: {
      const step = k === HomeKey.PrevHeading ? -1 : 1;
      for (let i = at + step; at >= 0 && i >= 0 && i < items.length; i += step) {
        if (items[i]!.heading && items[i]!.focusable) {
          setCursor(m, subject, i);
          break;
        }
      }
      break;
    }
    case HomeKey.Filter:
      s.filtering = true;
      break;
    case HomeKey.Inspect:
      inspect(m);
      break;
    // l only ever opens — it never dispatches, so the vim keys can't start
    // an install by accident. In the remote tree it unfolds a folded group.
    case HomeKey.Open: {
      const line = remoteLine();
      if (line !== undefined && line.group !== "" && s.collapsed.has(line.group)) {
        s.collapsed = without(s.collapsed, line.group);
        cursorOnHeading(m, line.group);
      }
      break;
    }
    // h in the remote tree folds the group under the cursor, landing on its
    // heading; anywhere else (or on a group with nothing to fold, like a
    // clean tool) it goes back to the sidebar. esc never folds.
    case HomeKey.Close: {
      const line = remoteLine();
      if (line !== undefined && line.group !== "" && !s.collapsed.has(line.group) && (s.filters.get(subject) ?? "") === "") {
        for (const l of remoteLines(ans!, s.collapsed)) {
          if (l.group === line.group && !heading(l)) {
            s.collapsed = withKeys(s.collapsed, line.group);
            cursorOnHeading(m, line.group);
            return;
          }
        }
      }
      focus(m, FocusArea.Sidebar);
      break;
    }
    // esc backs out one level, and never leaves the screen: the key you
    // press to back out of a list must not also end the session. q is the
    // only way out.
    case HomeKey.Esc:
      if ((s.filters.get(subject) ?? "") !== "") s.filters = withValue(s.filters, subject, "");
      // A finished run's panel is what's left open below the list (stacked,
      // it has its own page: esc there closes it).
      else if (finishedPanel(m) && !stacked(m)) dismissRun(m);
      else focus(m, FocusArea.Sidebar);
      break;
    // space ticks the row under the cursor — one unit at a time.
    case HomeKey.Select: {
      if (item === undefined) {
        hey(m, "nothing to tick there");
        return;
      }
      const row = item.index;
      switch (subject) {
        case SubjectPrograms: {
          const p = s.programs[row]!;
          if (!s.missing.some((r) => r.name === p.name)) {
            hey(m, p.name + " isn't missing — nothing to install");
            return;
          }
          s.chosen = toggled(s.chosen, p.name);
          break;
        }
        // Each script is its own unit, and ticking a done one is how you force it.
        case SubjectScripts:
          s.picked = toggled(s.picked, s.scripts[row]!.name);
          break;
        // Ticking an applied config writes it again: harmless, and how you
        // put back a file you deleted.
        case SubjectConfigs:
          s.applying = toggled(s.applying, s.configs[row]!.name);
          break;
        case SubjectRemote: {
          // A tool line, or a program under it, ticks the TOOL: loadout only
          // does whole upgrades. A source row ticks itself; its heading every
          // item under it, or clears them all when they already are.
          const line = remoteLine();
          if (line === undefined) {
            // nothing under the cursor
          } else if (line.kind === RemoteKind.Source && line.itemKeys.length > 0) {
            s.selection = containsAll(s.selection, line.itemKeys) ? without(s.selection, ...line.itemKeys) : withKeys(s.selection, ...line.itemKeys);
          } else if (line.key === "") {
            hey(m, refusal(line) || "nothing to tick there");
          } else {
            s.selection = toggled(s.selection, line.key);
          }
          break;
        }
        default:
          hey(m, "nothing to tick there");
      }
      break;
    }
    // K opens the page the row's source pointed at (the GitHub compare of the
    // two shas, like Lazy's K) in the browser.
    case HomeKey.OpenLink: {
      const line = remoteLine();
      const url = line !== undefined ? link(line) : "";
      if (url === "") hey(m, "no page to open for this row");
      else openInBrowser(m, url);
      break;
    }
    // a ticks everything, u unticks everything — two keys, so neither has to
    // guess what you meant from what's ticked.
    case HomeKey.SelectAll:
    case HomeKey.SelectNone: {
      const all = k === HomeKey.SelectAll;
      const pick = (names: Set<string>) => (all ? names : new Set<string>());
      switch (subject) {
        case SubjectPrograms:
          s.chosen = pick(namesSet(s.missing));
          break;
        case SubjectScripts:
          s.picked = pick(namesSet(s.scripts));
          break;
        case SubjectConfigs:
          s.applying = pick(namesSet(s.configs));
          break;
        case SubjectRemote: {
          if (ans === undefined) return;
          const every = new Set<string>();
          for (const l of remoteLines(ans, s.collapsed)) if (l.key !== "") every.add(l.key);
          s.selection = pick(every);
          break;
        }
        default:
          hey(m, "nothing to tick there");
      }
      break;
    }
    case HomeKey.Enter:
      act(m);
      break;
  }
}

/**
 * act is enter: the subject's verb on its ticks, through a confirm dialog.
 * Never on an answer still coming.
 */
function act(m: HomeModel): void {
  const s = m.state;
  const section = sectionOf(s);
  if (section === undefined) return;
  if (m.active !== undefined || m.waiting !== undefined) {
    hey(m, "a command is running — wait for it or ctrl+c it");
    return;
  }
  if (section.busy) {
    hey(m, "still asking — the rows fill in as answers land");
  } else if (section.subject === SubjectPrograms) {
    startInstalls(m, s.chosen);
  } else if (section.subject === SubjectScripts) {
    startScripts(m, s.picked);
  } else if (section.subject === SubjectConfigs) {
    startConfigs(m, s.applying);
  } else if (section.subject === SubjectRemote) {
    const ans: Answered | undefined = answered(s.remote);
    if (ans === undefined) {
      if (s.remote?.kind === "unavailable") hey(m, "the remotes couldn't be asked — r tries again");
      else hey(m, "the remotes haven't been asked — r asks them");
      return;
    }
    let line: RemoteLine | undefined;
    if (s.focus === FocusArea.Main) {
      const items = listOf(s, SubjectRemote);
      const at = snap(items, s.cursors.get(SubjectRemote) ?? 0);
      if (at >= 0) line = remoteLines(ans, s.collapsed)[items[at]!.index];
    }
    if (line !== undefined && line.kind === RemoteKind.Others) {
      // The sweep's cost, in full: every package the tool would move that
      // loadout doesn't declare, one per line.
      s.dialog = newDialog({
        kind: DialogKind.List,
        title: `${line.tool}: ${line.names.length} not in your loadout`,
        lines: line.names,
        summary: "These upgrade too when you upgrade " + line.tool + ".",
      });
    } else if (s.selection.size > 0) {
      startUpgrade(m, ans, s.selection);
    } else if (ans.updates.length === 0 && !ans.tools.some((t) => t.total === undefined || t.total > 0)) {
      hey(m, "everything up to date");
    } else {
      hey(m, "nothing selected — space selects one, a selects all");
    }
  } else if (section.subject === SubjectFleet) {
    hey(m, "this table is the comparison — there is nothing to run");
  }
}

/** listHeight is how many rows the main list shows at once. */
export function listHeight(m: HomeModel): number {
  return layout(m, m.shown !== undefined).listH;
}

/** halfPage is ctrl+d / ctrl+u's distance: half the list's height, at least one. */
function halfPage(m: HomeModel): number {
  return Math.max(Math.trunc(listHeight(m) / 2), 1);
}

/** moveCursor moves the main list's cursor by delta stops. */
export function moveCursor(m: HomeModel, delta: number): void {
  const s = m.state;
  const subject = subjectOf(s);
  const items = listOf(s, subject);
  const from = snap(items, s.cursors.get(subject) ?? 0);
  if (from < 0) return;
  const step = delta < 0 ? -1 : 1;
  let target = from;
  let left = delta * step;
  for (let i = from + step; i >= 0 && i < items.length && left > 0; i += step) {
    if (items[i]!.focusable) {
      target = i;
      left--;
    }
  }
  setCursor(m, subject, target);
}

/** setCursor puts subject's cursor on at, scrolling just enough to show it. */
export function setCursor(m: HomeModel, subject: string, at: number): void {
  const s = m.state;
  const view = Math.max(listHeight(m), 1);
  let offset = s.offsets.get(subject) ?? 0;
  offset = Math.min(offset, at);
  offset = Math.max(offset, at - view + 1, 0);
  s.cursors = withValue(s.cursors, subject, at);
  s.offsets = withValue(s.offsets, subject, offset);
}

/**
 * cursorOnHeading puts the remote cursor on group's heading after a fold
 * changed the tree under it.
 */
function cursorOnHeading(m: HomeModel, group: string): void {
  const items = listOf(m.state, SubjectRemote);
  const ans = answered(m.state.remote);
  if (ans === undefined) return;
  const lines = remoteLines(ans, m.state.collapsed);
  for (let i = 0; i < items.length; i++) {
    const l = lines[items[i]!.index]!;
    if (heading(l) && l.group === group) {
      setCursor(m, SubjectRemote, i);
      return;
    }
  }
}
