import type { AppContext, UpdateRow } from "../app/index.ts";
import { terminalColumns } from "../core/platform/platform.ts";
import { sortedStrings } from "../model/index.ts";
import type { Command } from "./args.ts";
import { exitWith } from "./errors.ts";
import { commandHelp } from "./help.ts";
import { appCtx, subcommand } from "./root.ts";
import { echo, spinning } from "./spinner.ts";
import { Style } from "./style.ts";
import { echoRows, padEnd, runeCount, severe, type TableRow } from "./table.ts";

/** newOutdatedCmd is `loadout outdated`. */
export function newOutdatedCmd(): Command {
  return subcommand(
    "outdated",
    commandHelp("Ask each program's remote source (dnf/brew/flathub/...) for newer versions — the loadout binary included."),
    [],
    () => runOutdated(appCtx()),
  );
}

async function runOutdated(a: AppContext): Promise<void> {
  const manifest = a.loadManifest();
  const system = a.detectSystem();
  const store = a.stateStore();
  const observed = store.read(system.machine);
  if (observed === undefined) {
    echo("error: no state for " + system.machine + " yet — run `loadout status` first");
    throw exitWith(1);
  }

  const n = manifest.outdated.size;
  const extra = n > 0 ? " and " + n + " extra source(s)" : "";
  const report = await spinning("asking the remotes" + extra + "…", () => a.outdatedReport(manifest, system, observed, true));
  const updates: UpdateRow[] = [...report.updates];

  // The doctor's line per tool first: what upgrading it would mean,
  // declared or not — the program rows below are the part loadout knows
  // by name.
  if (report.tools.length > 0) {
    let toolWidth = 0;
    for (const t of report.tools) toolWidth = Math.max(toolWidth, runeCount(t.tool));
    toolWidth += 2;
    for (const t of report.tools) {
      const mark = t.total === 0 ? Style.ok("✔") : Style.warn("↑");
      const count = t.total === 1 ? "1 update" : t.total + " updates";
      let what: string;
      if (t.total === 0) what = Style.dim("up to date");
      else if (t.declared.length === 0) what = count + Style.dim(" · none in your loadout");
      else what = count + Style.dim(" · " + t.declared.length + " in your loadout");
      const how = t.command !== undefined ? Style.dim("  loadout upgrade " + t.installers[0] + "  →  " + t.command) : "";
      echo(" " + mark + "  " + padEnd(t.tool, toolWidth) + what + how);
    }
    echo("");
  }

  // Same visual language as status: markers + color as signal only.
  if (updates.length === 0 && report.errors.length === 0) {
    echo(" " + Style.ok("✔") + "  everything is up to date");
  } else if (updates.length > 0) {
    // A column is as wide as its heading or its longest value, so the
    // heading never runs into the next one.
    let nameWidth = 7;
    let currentWidth = 7;
    let candidateWidth = 9;
    let sourceWidth = 6;
    for (const u of updates) {
      nameWidth = Math.max(nameWidth, runeCount(u.name));
      currentWidth = Math.max(currentWidth, runeCount(u.current));
      candidateWidth = Math.max(candidateWidth, runeCount(u.candidate));
      sourceWidth = Math.max(sourceWidth, runeCount(u.source));
    }
    nameWidth += 2;
    currentWidth += 2;
    candidateWidth += 2;
    sourceWidth += 2;
    echo(Style.header(" " + padEnd("PROGRAM", nameWidth + 3) + padEnd("CURRENT", currentWidth + 3) + padEnd("CANDIDATE", candidateWidth) + "SOURCE"));
    for (const u of updates) {
      let annotation = "";
      if (u.note !== "") annotation += Style.dim("  " + u.note);
      if (u.link !== undefined) annotation += Style.dim("  " + u.link);
      echo(
        " " + Style.warn("↑") + "  " + padEnd(u.name, nameWidth) + padEnd(u.current, currentWidth) +
          Style.dim("-> ") + Style.warn(padEnd(u.candidate, candidateWidth)) + Style.dim(padEnd("[" + u.source + "]", sourceWidth)) + annotation,
      );
    }
    echo("");
    echo(
      " " + Style.warn("↑") + "  " + updates.length + " update(s) available" +
        // Converge adds what's MISSING; a newer version of something
        // already installed is the package manager's business.
        Style.dim(
          " — neither `setup-new-machine` nor `install --all` upgrades them; both only install what's MISSING. " +
            "Upgrade with the package manager, or `loadout upgrade <program>` for one that declares its own upgrade; then `loadout status`",
        ),
    );
  }
  // A broken oracle is a different severity sitting under a long list of
  // ordinary updates — box it, the one place in this screen where a row
  // contrasts with its neighbours. The message carries a stderr tail, so
  // clamp it to the terminal: a box that wraps is worse than a plain line.
  if (report.errors.length > 0) {
    const tail = " — its results are missing this run";
    let cols = terminalColumns();
    if (cols === 0) cols = 100;
    const budget = cols - 6 - runeCount(tail);
    const rows: TableRow[] = [];
    for (const e of report.errors) {
      let head = "  outdated source [" + e.label + "] failed: " + e.reason;
      if (runeCount(head) > budget) head = [...head].slice(0, Math.max(budget - 1, 0)).join("") + "…";
      rows.push({ lines: [Style.error("✖") + head + Style.dim(tail)], severity: severe });
    }
    echoRows(rows);
  }
  if (report.unchecked.length > 0) {
    const unchecked = sortedStrings(report.unchecked);
    echo(Style.dim(" ·  " + unchecked.length + " installed programs have no outdated oracle: " + unchecked.join(", ")));
  }
}
