import { type AppContext, behindRelease } from "../app/index.ts";
import {
  configApplied,
  configDrifted,
  done,
  installed,
  type MachineState,
  missing,
  pending,
} from "../core/coremodel/coremodel.ts";
import * as engine from "../core/engine/index.ts";
import { encode } from "../core/state/index.ts";
import { sortedStrings } from "../model/index.ts";
import { VERSION } from "../version.ts";
import type { Command } from "./args.ts";
import { boolFlag, commandHelp } from "./help.ts";
import { appCtx, subcommand } from "./root.ts";
import { echo, echoErr, ensureBun, spinning } from "./spinner.ts";
import { Style } from "./style.ts";
import { attention, echoRows, padEnd, runeCount, severe, type TableRow } from "./table.ts";

/** newStatusCmd is `loadout status`. */
export function newStatusCmd(): Command {
  const cmd = subcommand(
    "status",
    commandHelp(
      "Observe this machine: every program version and script check re-asked, drift explained, state file updated.",
      "--json      print the full state as JSON",
      "--no-write  observe without touching the state file",
    ),
    [],
    (_cmd, _args, flags) => runStatus(appCtx(), flags.bool("json"), flags.bool("no-write")),
  );
  boolFlag(cmd, "json", "", "Print the machine state as JSON");
  boolFlag(cmd, "no-write", "", "Don't update the state file");
  return cmd;
}

/** Observed is one refresh and what it couldn't answer. */
interface Observed {
  state: MachineState;
  detail: Map<string, string>;
  toolsDown: engine.ToolDown[];
  configsDown: string | undefined;
}

async function runStatus(a: AppContext, jsonOut: boolean, noWrite: boolean): Promise<void> {
  const manifest = a.loadManifest();
  await ensureBun(a, manifest);
  const system = a.detectSystem();
  const store = a.stateStore();
  const subjects = a.configs() !== undefined ? "programs, scripts and configs" : "programs and scripts";
  const seen = await spinning("checking " + subjects + "…", async (): Promise<Observed> => {
    if (noWrite) {
      const observer = await a.statusEngine(system);
      const s = await observer.refresh(manifest, system, store.read(system.machine), new Map());
      return { state: s, detail: observer.lastScriptDetail(), toolsDown: observer.lastToolsDown(), configsDown: observer.lastConfigsDown() };
    }
    const s = await a.refreshAndWriteState(manifest, system, new Map());
    return { state: s, detail: a.lastScriptDetail(), toolsDown: a.lastToolsDown(), configsDown: a.lastConfigsDown() };
  });
  for (const w of store.lastWarnings()) echoErr("warning: " + w);

  if (jsonOut) {
    echo(encode(seen.state).replace(/\n$/, ""));
    return;
  }
  printStatusTable(seen.state, seen.detail);
  // The per-row boxes say WHICH programs; this says what happened, once,
  // in words: the tool the checks go through wasn't there.
  for (const down of seen.toolsDown) {
    echo("");
    echo(" " + Style.warn("⚠") + "  " + Style.warn(engine.toolDownMessage(down)) + Style.dim("  (" + down.programs.join(", ") + ")"));
  }
  if (seen.configsDown !== undefined) {
    echo("");
    echo(" " + Style.warn("⚠") + "  " + Style.warn("configs not checked: " + seen.configsDown));
  }
  if (manifest.meta.bun !== undefined) {
    let dir: string | undefined;
    try {
      dir = await a.bunDir();
    } catch {
      dir = undefined;
    }
    if (dir !== undefined) {
      echo("");
      echo(Style.dim(" ·  scripts run with bun " + manifest.meta.bun + " (" + dir + ")"));
    }
  }
  // The one self-knowledge carve-out: is this binary itself behind?
  const latest = await behindRelease(a.runner, true);
  if (latest !== "") {
    echo("");
    echo(" " + Style.warn("↑") + "  loadout " + VERSION + " — " + latest + " available " + Style.dim("(run: loadout self-upgrade)"));
  }
  if (!noWrite) echo(Style.dim("\nState written to " + store.pathFor(system.machine)));
}

/** sortedKeys is m's keys in name order. */
export function sortedKeys<V>(m: ReadonlyMap<string, V>): string[] {
  return sortedStrings(m.keys());
}

// Same visual language as the home screen: ✔/✘/· markers, color as signal
// only (ok/warn/error/dim), dim detail lines under failing rows.
function printStatusTable(s: MachineState, detail: ReadonlyMap<string, string>): void {
  const distro = s.distro !== undefined ? "/" + s.distro : "";
  echo(Style.dim("machine ") + Style.machine(s.machine) + Style.dim(" │ " + s.os + distro + " │ " + s.arch));
  echo("");
  let nameWidth = 7;
  for (const keys of [s.programs.keys(), s.scripts.keys(), s.configs.keys()]) {
    for (const k of keys) nameWidth = Math.max(nameWidth, runeCount(k));
  }
  echo(Style.header("  " + padEnd("PROGRAM", nameWidth + 4) + padEnd("STATUS", 13) + "VERSION"));
  // Rows that aren't settled get boxed by echoRows, same as diff's drift
  // rows: a missing install is severe, a pending script is not.
  const rows: TableRow[] = [];
  for (const name of sortedKeys(s.programs)) {
    const program = s.programs.get(name)!;
    let mark: string;
    let status: string;
    let severity: boolean | undefined;
    if (program.status === installed) {
      mark = Style.ok("✔");
      status = Style.ok(padEnd("installed", 13));
    } else if (program.status === missing) {
      mark = Style.error("✘");
      status = Style.error(padEnd("missing", 13));
      severity = severe;
    } else if (program.reason === undefined) {
      mark = Style.dim("·");
      status = Style.dim(padEnd("unknown", 13));
    } else {
      // An unknown WITH a reason is a check that couldn't run (brew off
      // PATH): unsettled, boxed amber, the reason inside the box — never
      // a quiet "-" that reads as nothing wrong.
      mark = Style.warn("?");
      status = Style.warn(padEnd("not checked", 13));
      severity = attention;
    }
    const lines = [mark + "  " + padEnd(name, nameWidth + 1) + status + (program.version ?? "-")];
    if (program.reason !== undefined) lines.push(Style.dim("     " + program.reason));
    rows.push(row(lines, severity));
  }
  echoRows(rows);
  printStatusScripts(s, detail, nameWidth);
  printStatusConfigs(s, nameWidth);
}

/** row is a TableRow of lines, boxed with severity when it has one. */
function row(lines: string[], severity: boolean | undefined): TableRow {
  return severity === undefined ? { lines } : { lines, severity };
}

function printStatusScripts(s: MachineState, detail: ReadonlyMap<string, string>, nameWidth: number): void {
  if (s.scripts.size === 0) return;
  echo("");
  echo(Style.header("  " + padEnd("SCRIPT", nameWidth + 4) + "STATUS"));
  const rows: TableRow[] = [];
  for (const name of sortedKeys(s.scripts)) {
    let mark: string;
    let status: string;
    let severity: boolean | undefined;
    switch (s.scripts.get(name)!.status) {
      case done:
        mark = Style.ok("✔");
        status = Style.ok("done");
        break;
      case pending:
        mark = Style.warn("✘");
        status = Style.warn("pending");
        severity = attention;
        break;
      default:
        mark = Style.error("✘");
        status = Style.error("failed");
        severity = severe;
    }
    const lines = [mark + "  " + padEnd(name, nameWidth + 1) + status];
    // What the failing check reported — the "missing: ..." lines, inside
    // the box with the row they explain.
    const d = detail.get(name);
    if (d !== undefined) {
      for (const line of d.split("\n")) lines.push(Style.dim(padEnd("", nameWidth + 5) + line));
    }
    rows.push(row(lines, severity));
  }
  echoRows(rows);
}

// A drifted unit lists the files apply would change, inside its box.
function printStatusConfigs(s: MachineState, nameWidth: number): void {
  if (s.configs.size === 0) return;
  echo("");
  echo(Style.header("  " + padEnd("CONFIG", nameWidth + 4) + "STATUS"));
  const rows: TableRow[] = [];
  for (const name of sortedKeys(s.configs)) {
    const config = s.configs.get(name)!;
    let mark: string;
    let status: string;
    let severity: boolean | undefined;
    if (config.status === configApplied) {
      mark = Style.ok("✔");
      status = Style.ok("applied");
    } else if (config.status === configDrifted) {
      mark = Style.warn("✘");
      status = Style.warn("drifted");
      severity = attention;
    } else {
      mark = Style.warn("?");
      status = Style.warn("not checked");
      severity = attention;
    }
    const lines = [mark + "  " + padEnd(name, nameWidth + 1) + status];
    const extra = [...config.files];
    if (config.reason !== undefined) extra.push(config.reason);
    for (const line of extra) lines.push(Style.dim(padEnd("", nameWidth + 5) + line));
    rows.push(row(lines, severity));
  }
  echoRows(rows);
}
