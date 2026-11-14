import type { MachineState } from "../core/coremodel/coremodel.ts";
import * as diff from "../core/diff/diff.ts";
import { joinPath, trimSpace } from "../model/index.ts";
import type { Command } from "./args.ts";
import { exitWith } from "./errors.ts";
import { commandHelp, stringFlag } from "./help.ts";
import { appCtx, subcommand } from "./root.ts";
import { echo, echoErr } from "./spinner.ts";
import { Style } from "./style.ts";
import { attention, echoRows, padEnd, codePointCount, severe, type TableRow } from "./table.ts";

function driftedLabel(cell: diff.ConfigCell): string {
  return "drifted (" + cell.files + ")";
}

function flagsOf(row: diff.ProgramRow): string {
  const flags: string[] = [];
  if (diff.drift(row)) flags.push("drift");
  if (diff.incomplete(row)) flags.push("incomplete");
  return flags.join(",");
}

/** newDiffCmd is `loadout diff`. */
export function newDiffCmd(): Command {
  const cmd = subcommand(
    "diff",
    commandHelp(
      "Compare all machines' state files: missing installs, version drift and drifted configs. Exits 1 when something is off.",
      "--machines a,b  narrow the comparison to those machines",
    ),
    [],
    (_cmd, _args, flags) => runDiff(flags.string("machines"), flags.changed("machines")),
  );
  stringFlag(cmd, "machines", "", "", "Comma-separated machine names to compare (default: all with a state file)");
  return cmd;
}

/** cellOf is the program's cell for machine m, unknown when absent. */
function cellOf(r: diff.ProgramRow, m: string): diff.InstallState {
  return r.perMachine.get(m) ?? { kind: diff.unknown };
}

/** configCellOf is the unit's cell for machine m, unknown when absent. */
function configCellOf(r: diff.ConfigRow, m: string): diff.ConfigCell {
  return r.perMachine.get(m) ?? { kind: diff.configUnknown, files: 0 };
}

async function runDiff(machines: string, given: boolean): Promise<void> {
  const a = appCtx();
  const manifest = a.loadManifest();
  let filter: string[] | undefined;
  if (given) {
    filter = [];
    for (let m of machines.split(",")) {
      m = trimSpace(m);
      if (m !== "") filter.push(m);
    }
  }
  const fleet = a.fleetStates();
  const states: MachineState[] = [];
  for (const [name, s] of fleet) {
    if (filter === undefined || filter.includes(name)) states.push(s);
  }
  for (const w of a.fleetWarnings()) echoErr("warning: " + w);

  if (states.length === 0) {
    const layout = a.layout();
    echo("No machine state files found in " + joinPath(a.repoRoot, layout.state) + ". Run `status` or `sync` on your machines first.");
    throw exitWith(1);
  }

  const report = diff.diff(manifest, states);

  let nameWidth = 7;
  for (const r of report.rows) nameWidth = Math.max(nameWidth, codePointCount(r.program));
  for (const c of report.configs) nameWidth = Math.max(nameWidth, codePointCount(c.unit));
  nameWidth += 2;
  let colWidth = 8;
  for (const m of report.machines) colWidth = Math.max(colWidth, codePointCount(m));
  for (const c of report.configs) {
    for (const cell of c.perMachine.values()) {
      if (cell.kind === diff.configDrifted) colWidth = Math.max(colWidth, codePointCount(driftedLabel(cell)));
    }
  }
  colWidth += 2;
  let machineHeads = "";
  for (const m of report.machines) machineHeads += Style.machine(padEnd(m, colWidth));
  echo(Style.header("  " + padEnd("PROGRAM", nameWidth + 3)) + machineHeads);
  // Rows needing attention (drift, or a missing install somewhere) are
  // boxed by echoRows; the rest print with the same gutter.
  const rows: TableRow[] = [];
  for (const r of report.rows) {
    // Same marker language as status: ok / drift / missing-somewhere; a
    // program no compared machine has is a dim non-event.
    let everywhereUnknown = true;
    for (const cell of r.perMachine.values()) everywhereUnknown = everywhereUnknown && cell.kind === diff.unknown;
    const isDrift = diff.drift(r);
    const isIncomplete = diff.incomplete(r);
    let marker: string;
    if (isIncomplete) marker = Style.error("✘");
    else if (isDrift) marker = Style.warn("!");
    else if (everywhereUnknown) marker = Style.dim("·");
    else marker = Style.ok("✔");
    let cells = "";
    for (const m of report.machines) {
      const cell = cellOf(r, m);
      if (cell.kind === diff.installed) {
        // On a drifting row every version is a suspect — highlight them all.
        const v = padEnd(cell.version ?? "ok", colWidth);
        cells += isDrift ? Style.warn(v) : v;
      } else if (cell.kind === diff.missing) {
        cells += Style.error(padEnd("missing", colWidth));
      } else {
        cells += Style.dim(padEnd("-", colWidth));
      }
    }
    let line = marker + "  " + padEnd(r.program, nameWidth) + cells;
    const flags = flagsOf(r);
    if (flags !== "") line += Style.warn("  !" + flags);
    if (isIncomplete) rows.push({ lines: [line], severity: severe });
    else if (isDrift) rows.push({ lines: [line], severity: attention });
    else rows.push({ lines: [line] });
  }
  echoRows(rows);

  printDiffConfigs(report, nameWidth, colWidth);

  const driftCount = report.rows.filter(diff.drift).length;
  const missingCount = report.rows.filter(diff.incomplete).length;
  const configCount = report.configs.filter(diff.drifted).length;
  if (driftCount > 0 || missingCount > 0 || configCount > 0) {
    echo("");
    const tail = report.configs.length > 0 ? ", " + configCount + " config(s) drifted." : ".";
    echo(
      " " + Style.warn("!") + "  " + driftCount + " program(s) with version drift, " + missingCount + " with missing installs" + tail,
    );
    throw exitWith(1);
  }
  echo("");
  echo(" " + Style.ok("✔") + "  all " + report.machines.length + " machine(s) in sync");
}

// A unit a machine doesn't report is "-": chezmoi ignores it there, or that
// machine's state predates configs.
function printDiffConfigs(report: diff.DiffReport, nameWidth: number, colWidth: number): void {
  if (report.configs.length === 0) return;
  echo("");
  let machineHeads = "";
  for (const m of report.machines) machineHeads += Style.machine(padEnd(m, colWidth));
  echo(Style.header("  " + padEnd("CONFIG", nameWidth + 3)) + machineHeads);
  const rows: TableRow[] = [];
  for (const c of report.configs) {
    const isDrifted = diff.drifted(c);
    const marker = isDrifted ? Style.warn("✘") : Style.ok("✔");
    let cells = "";
    for (const m of report.machines) {
      const cell = configCellOf(c, m);
      if (cell.kind === diff.configApplied) cells += padEnd("applied", colWidth);
      else if (cell.kind === diff.configDrifted) cells += Style.warn(padEnd(driftedLabel(cell), colWidth));
      else cells += Style.dim(padEnd("-", colWidth));
    }
    const line = marker + "  " + padEnd(c.unit, nameWidth) + cells;
    rows.push(isDrifted ? { lines: [line], severity: attention } : { lines: [line] });
  }
  echoRows(rows);
}
