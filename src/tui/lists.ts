import {
  answered,
  type ConfigItem,
  driftedRows,
  fleetLineName,
  focusable,
  heading,
  type HomeSection,
  type HomeState,
  type ProgramRow,
  RemoteKind,
  type RemoteLine,
  remoteLines,
  runes,
  type ScriptRow,
} from "./homemodel.ts";

// Subjects, as HomeSection.subject names them: the keys of the per-subject
// cursors, offsets and filters.
export const SubjectPrograms = "programs";
export const SubjectScripts = "scripts";
export const SubjectConfigs = "configs";
export const SubjectRemote = "remote";
export const SubjectFleet = "fleet";

/**
 * Item is one row of the main pane's list, as both the cursor and the
 * renderer see it: index is the row in its subject's own list (programs,
 * scripts, configs, remoteLines, driftedRows).
 */
export interface Item {
  index: number;
  name: string;
  /** focusable says the row is a cursor stop (the remote tree's gaps are not). */
  focusable: boolean;
  /**
   * heading says the row heads a group (a remote tool or source): what
   * `[`/`]` jump between.
   */
  heading: boolean;
  /** matches is the code point positions in name the filter matched. */
  matches: number[];
}

/** subjectOf is the subject the main pane shows ("" when there is none yet): Go's HomeState.subject. */
export function subjectOf(s: HomeState): string {
  if (s.subject < 0 || s.subject >= s.sections.length) return "";
  return s.sections[s.subject]!.subject;
}

/** sectionOf is the subject the main pane shows, as its section: Go's HomeState.section. */
export function sectionOf(s: HomeState): HomeSection | undefined {
  if (s.subject < 0 || s.subject >= s.sections.length) return undefined;
  return s.sections[s.subject];
}

/** listOf is subject's list as the main pane shows it, its filter applied. */
export function listOf(s: Pick<HomeState, "filters" | "programs" | "scripts" | "configs" | "fleet" | "remote" | "collapsed">, subject: string): Item[] {
  const filter = s.filters.get(subject) ?? "";
  const plain = (names: string[]): Item[] => {
    const items: Item[] = [];
    names.forEach((name, i) => {
      const [matches, ok] = fuzzy(filter, name);
      if (ok) items.push({ index: i, name, focusable: true, heading: false, matches });
    });
    return items;
  };
  switch (subject) {
    case SubjectPrograms:
      return plain(s.programs.map((p: ProgramRow) => p.name));
    case SubjectScripts:
      return plain(s.scripts.map((r: ScriptRow) => r.name));
    case SubjectConfigs:
      return plain(s.configs.map((c: ConfigItem) => c.name));
    case SubjectFleet:
      return plain(driftedRows(s).map(fleetLineName));
    case SubjectRemote: {
      const ans = answered(s.remote);
      if (ans === undefined) return [];
      const lines = remoteLines(ans, s.collapsed);
      if (filter === "") {
        return lines.map((l, i) => ({ index: i, name: remoteName(l), focusable: focusable(l), heading: heading(l), matches: [] }));
      }
      // Filtered, the tree keeps a matching row's heading (so the row still
      // says what acts on it) and a matching heading's every row; gaps go.
      const items: Item[] = [];
      let headingMatched = false;
      let headingAt = -1;
      let headingShown = false;
      lines.forEach((l, i) => {
        if (l.kind === RemoteKind.Gap) return;
        if (heading(l)) {
          const [matches, ok] = fuzzy(filter, remoteName(l));
          headingAt = i;
          headingMatched = ok;
          headingShown = ok;
          if (ok) items.push({ index: i, name: remoteName(l), focusable: true, heading: true, matches });
          return;
        }
        const [matches, ok] = fuzzy(filter, remoteName(l));
        if (!ok && !headingMatched) return;
        if (!headingShown && headingAt >= 0) {
          items.push({ index: headingAt, name: remoteName(lines[headingAt]!), focusable: true, heading: true, matches: [] });
          headingShown = true;
        }
        items.push({ index: i, name: remoteName(l), focusable: true, heading: false, matches });
      });
      return items;
    }
  }
  return [];
}

/** remoteName is what a remote line is called, for the filter. */
function remoteName(l: RemoteLine): string {
  switch (l.kind) {
    case RemoteKind.Tool:
      return l.info.tool;
    case RemoteKind.Program:
    case RemoteKind.Item:
      return l.row.name;
    case RemoteKind.Source:
      return l.name;
  }
  return "";
}

/**
 * fuzzy matches query against text as a case-insensitive subsequence,
 * preferring the earliest match of each code point; it returns the matched
 * positions. An empty query matches everything, with nothing underlined.
 */
export function fuzzy(query: string, text: string): [number[], boolean] {
  if (query === "") return [[], true];
  const q = [...query.toLowerCase()];
  const matches: number[] = [];
  let at = 0;
  let i = 0;
  for (const r of text) {
    if (at < q.length && r.toLowerCase() === q[at]) {
      matches.push(i);
      at++;
    }
    i++;
  }
  return [matches, at === q.length];
}

/**
 * snap is the item the cursor really sits on: the nearest stop at or above
 * cursor, else below (-1: nothing to stop on). Lists reshape under the
 * cursor constantly — a refresh empties the missing programs, an upgrade
 * clears a source — and a cursor left on nothing would highlight nothing.
 */
export function snap(items: readonly Item[], cursor: number): number {
  if (items.length === 0) return -1;
  const at = Math.min(Math.max(cursor, 0), items.length - 1);
  for (let i = at; i >= 0; i--) if (items[i]!.focusable) return i;
  for (let i = at; i < items.length; i++) if (items[i]!.focusable) return i;
  return -1;
}

/**
 * wrapWords is text broken at spaces into lines of at most width (a longer
 * word gets a line of its own).
 */
export function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") line = word;
    else if (runes(line) + 1 + runes(word) <= width) line += " " + word;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}
