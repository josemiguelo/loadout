import * as app from "../app/index.ts";
import { missing } from "../core/coremodel/coremodel.ts";
import * as diff from "../core/diff/diff.ts";
import { answered, driftedRows, errorText, firstLine, fleetLineName, type HomeModel, later, RemoteKind, remoteLines } from "./homemodel.ts";
import { hey } from "./keys.ts";
import { listOf, snap, SubjectConfigs, SubjectFleet, subjectOf, SubjectPrograms, SubjectRemote, SubjectScripts } from "./lists.ts";

/**
 * Inspector is the main pane's detail view of one program, script or config:
 * what `explain` says about it, this machine's last observation and every
 * machine's from the fleet.
 */
export interface Inspector {
  name: string;
  /**
   * items is explain's answer for name (a program or script, and a config of
   * the same name); err is why there is none.
   */
  items: app.Explained[];
  err: string;
  /** machine is this machine's last verdict, as label/value rows. */
  machine: app.ExplainRow[];
  /** fleet is every machine's verdict from the state files. */
  fleet: app.ExplainRow[];
  /** scroll is the first line shown. */
  scroll: number;
}

/** newInspector is an Inspector of name with nothing in it yet. */
export function newInspector(name: string): Inspector {
  return { name, items: [], err: "", machine: [], fleet: [], scroll: 0 };
}

/**
 * inspect opens the inspector on the row under the main pane's cursor. It
 * opens once explain has answered (Go's answered at once; here it may take
 * a moment, the list staying until then).
 */
export function inspect(m: HomeModel): void {
  const name = inspectable(m);
  if (name === "") {
    hey(m, "i inspects a program, a script or a config");
    return;
  }
  const open = (m: HomeModel, explained: app.ExplainedName[], err: unknown) => {
    const inspector = newInspector(name);
    if (err instanceof app.NoSuchItemError) inspector.err = err.message;
    else if (err !== undefined) inspector.err = firstLine(errorText(err));
    for (const named of explained) inspector.items.push(...named.items);
    inspector.machine = machineRows(m, name);
    inspector.fleet = fleetRows(m.state.fleet, name);
    m.state.inspect = inspector;
    m.state.filtering = false;
  };
  if (m.explain === undefined) {
    const inspector = newInspector(name);
    inspector.err = "nothing to explain without a repo";
    inspector.machine = machineRows(m, name);
    inspector.fleet = fleetRows(m.state.fleet, name);
    m.state.inspect = inspector;
    m.state.filtering = false;
    return;
  }
  let answer: app.ExplainedName[] | Promise<app.ExplainedName[]>;
  try {
    answer = m.explain([name]);
  } catch (e) {
    open(m, e instanceof app.NoSuchItemError ? e.explained : [], e);
    return;
  }
  later(
    m,
    answer,
    (m, explained) => open(m, explained, undefined),
    (m, e) => open(m, e instanceof app.NoSuchItemError ? e.explained : [], e),
  );
}

/**
 * inspectable is the name of the program, script or config under the main
 * pane's cursor ("" when it is none: a tool, a source's item).
 */
function inspectable(m: HomeModel): string {
  const s = m.state;
  const subject = subjectOf(s);
  const items = listOf(s, subject);
  const at = snap(items, s.cursors.get(subject) ?? 0);
  if (at < 0) return "";
  const row = items[at]!.index;
  switch (subject) {
    case SubjectPrograms:
      return s.programs[row]!.name;
    case SubjectScripts:
      return s.scripts[row]!.name;
    case SubjectConfigs:
      return s.configs[row]!.name;
    case SubjectFleet:
      return fleetLineName(driftedRows(s)[row]!);
    case SubjectRemote: {
      const ans = answered(s.remote);
      if (ans !== undefined) {
        const l = remoteLines(ans, s.collapsed)[row]!;
        if (l.kind === RemoteKind.Program) return l.row.name;
      }
    }
  }
  return "";
}

function row(label: string, value: string): app.ExplainRow {
  return { label, value, machine: "" };
}

/** machineRows is this machine's last verdict on name, from the rows on screen. */
function machineRows(m: HomeModel, name: string): app.ExplainRow[] {
  const rows: app.ExplainRow[] = [];
  const s = m.state;
  for (const p of s.programs) {
    if (p.name !== name) continue;
    let status: string = p.status === "" ? "not observed yet" : p.status;
    if (p.version !== "") status += " " + p.version;
    rows.push(row("program", status));
    if (p.status === missing) rows.push(row("installs via", p.installKey));
  }
  for (const r of s.scripts) {
    if (r.name !== name) continue;
    rows.push(row("script", r.status === "" ? "not observed yet" : r.status));
    if (r.command !== "") rows.push(row("runs", r.command));
  }
  for (const c of s.configs) {
    if (c.name !== name) continue;
    rows.push(row("config", c.status === "" ? "not observed yet" : c.status));
    c.files.forEach((f, i) => rows.push(row(i === 0 ? "would change" : "", f)));
  }
  const ans = answered(s.remote);
  if (ans !== undefined) {
    for (const u of ans.updates) {
      if (u.name === name && !ans.sources.has(u.source)) rows.push(row("update", u.current + " → " + u.candidate));
    }
  }
  return rows;
}

/** fleetRows is every machine's verdict on name, from the fleet comparison. */
export function fleetRows(fleet: diff.DiffReport | undefined, name: string): app.ExplainRow[] {
  if (fleet === undefined) return [];
  const rows: app.ExplainRow[] = [];
  for (const r of fleet.rows) {
    if (r.program !== name) continue;
    for (const machine of fleet.machines) {
      let cell = "not installed there";
      const state = r.perMachine.get(machine);
      if (state !== undefined) {
        if (state.kind === diff.installed) cell = state.version ?? "installed";
        else if (state.kind === diff.missing) cell = "missing";
        else cell = "unknown";
      }
      rows.push(row(machine, cell));
    }
    if (diff.incomplete(r)) rows.push(row("verdict", "missing somewhere"));
    else if (diff.drift(r)) rows.push(row("verdict", "versions differ"));
    else rows.push(row("verdict", "in sync"));
  }
  for (const r of fleet.configs) {
    if (r.unit !== name) continue;
    for (const machine of fleet.machines) {
      let cell = "-";
      const state = r.perMachine.get(machine);
      if (state !== undefined) {
        if (state.kind === diff.configApplied) cell = "applied";
        else if (state.kind === diff.configDrifted) cell = "drifted (" + state.files + ")";
        else cell = "not checked";
      }
      rows.push(row(machine + " (config)", cell));
    }
  }
  return rows;
}
