import { type AppContext, type ExplainedName, NoSuchItemError } from "../app/index.ts";
import { dataLines, scriptEntry, sortStrings, sortedStrings } from "../model/index.ts";
import type { Command } from "./args.ts";
import { exitWith } from "./errors.ts";
import { commandHelp } from "./help.ts";
import { appCtx, subcommand } from "./root.ts";
import { echo } from "./spinner.ts";
import { Style } from "./style.ts";
import { padEnd, runeCount } from "./table.ts";

/** newExplainCmd is `loadout explain`. */
export function newExplainCmd(): Command {
  return subcommand(
    "explain",
    commandHelp(
      "Explain programs, scripts or configs: the fully expanded definition exactly as the engine sees it.",
      "[names...]  programs, scripts or configs (default: every program and script)",
    ),
    [{ name: "names", help: "Program, script or config names (default: every program and script)", optional: true, multiple: true }],
    (_cmd, args) => runExplain(appCtx(), args),
  );
}

/** Row is one `label  value` line of explain's output. */
export interface Row {
  label: string;
  value: string;
}

/** echoLabelled prints rows with their labels in one dim column. */
export function echoLabelled(rows: readonly Row[]): void {
  let width = 0;
  for (const r of rows) width = Math.max(width, runeCount(r.label));
  for (const r of rows) echo("  " + Style.dim(padEnd(r.label, width)) + "  " + r.value);
}

async function runExplain(a: AppContext, names: string[]): Promise<void> {
  const manifest = a.loadManifest();
  const layout = a.layout();
  const system = a.detectSystem();
  a.stateStore();
  const machine = manifest.machines.get(system.machine);
  const declared = machine !== undefined;
  const mapping = machine?.pm ?? new Map<string, string>();

  // Everything explained starts with the machine: the profiles it extends,
  // what it installs and runs (its profiles' included), and its merged
  // data (what its chezmoi templates see).
  if (names.length === 0) {
    echo(Style.header("machine ") + Style.bold(system.machine));
    if (!declared) echo("  " + Style.warn("! not declared in the repo — showing the data defaults"));
    const rows: Row[] = [];
    if (layout.parent !== undefined) rows.push({ label: "parent", value: layout.parent.name + " (" + layout.parent.path + ")" });
    if (machine !== undefined && machine.extends.length > 0) rows.push({ label: "extends", value: machine.extends.join(", ") });
    // What it installs, grouped by the variant each program uses.
    const byVariant = new Map<string, string[]>();
    for (const [program, variant] of mapping) byVariant.set(variant, [...(byVariant.get(variant) ?? []), program]);
    for (const v of sortedStrings(byVariant.keys())) {
      rows.push({ label: "install " + v, value: sortStrings(byVariant.get(v)!).join(", ") });
    }
    if (machine !== undefined && machine.scripts.length > 0) {
      const entries = machine.scripts.map((entry) => {
        let [name] = scriptEntry(entry);
        const variant = machine.scriptVariants.get(name);
        if (variant !== undefined) name += " (" + variant + ")";
        return name;
      });
      rows.push({ label: "run", value: entries.join(", ") });
    }
    const data = machine !== undefined ? machine.data : manifest.data;
    const lines = dataLines(data, "");
    for (const line of lines) rows.push({ label: "data." + line.key, value: line.value });
    if (lines.length === 0) echo("  " + Style.dim("no data declared"));
    echoLabelled(rows);
    echo("");
  }

  let explained: ExplainedName[];
  let unknown: NoSuchItemError | undefined;
  try {
    explained = await a.explain(names);
  } catch (e) {
    if (!(e instanceof NoSuchItemError)) throw e;
    unknown = e;
    explained = e.explained;
  }
  explained.forEach((named, index) => {
    if (index > 0) echo("");
    named.items.forEach((item, j) => {
      if (j > 0) echo("");
      let title = Style.header(item.kind + " ") + Style.bold(item.name);
      if (item.kind === "config") title += Style.dim("  " + item.folder);
      else if (item.description !== "") title += Style.dim("  — " + item.description);
      echo(title);
      echoLabelled(item.rows.map((r) => ({ label: r.label, value: r.machine !== "" ? r.value + Style.machine("   <- " + r.machine) : r.value })));
      for (const note of item.notes) echo("  " + Style.warn(note));
    });
  });
  if (unknown !== undefined) {
    if (explained.length > 0) echo("");
    echo("error: " + unknown.message);
    throw exitWith(1);
  }
}
