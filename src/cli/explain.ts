import { type AppContext, type ExplainedName, NoSuchItemError } from "../app/index.ts";
import { dataLines, sortStrings, sortedStrings } from "../model/index.ts";
import type { Command } from "./args.ts";
import { exitWith } from "./errors.ts";
import { commandHelp } from "./help.ts";
import { appCtx, subcommand } from "./root.ts";
import { echo } from "./spinner.ts";
import { Style } from "./style.ts";
import { padEnd, codePointCount } from "./table.ts";

/** Kind is what one explain verb covers: a kind of item, or this machine's overview. */
export type ExplainKind = "program" | "script" | "config" | "machine";

const kindHelp: Record<ExplainKind, [string, string]> = {
  program: ["Explain programs: each one's fully expanded definition, exactly as the engine sees it for this machine.", "programs (default: every program)"],
  script: ["Explain scripts: each one's fully expanded definition, exactly as the engine sees it for this machine.", "scripts (default: every script)"],
  config: ["Explain configs: each one's files and last verdict (a / config's too: /<tool>).", "configs (default: every config)"],
  machine: ["Explain this machine: the profiles it extends, what it installs and runs, and its merged data (what its templates see).", ""],
};

/**
 * newExplainCmd is `loadout <kind> explain`: one kind's items, or this
 * machine's overview. Without a kind it's loadout 6.0's `explain`, every
 * kind at once (kept as an alias until 7.0).
 */
export function newExplainCmd(name = "explain", kind?: ExplainKind): Command {
  const [help, names] =
    kind !== undefined ? kindHelp[kind] : ["Explain programs, scripts or configs: the fully expanded definition exactly as the engine sees it.", "programs, scripts or configs (default: every program and script)"];
  const args = kind === "machine" ? [] : [{ name: "names", help: names, optional: true, multiple: true }];
  return subcommand(
    name,
    kind === "machine" ? commandHelp(help) : commandHelp(help, "[names...]  " + names),
    args,
    (_cmd, given) => runExplain(appCtx(), given, kind),
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
  for (const r of rows) width = Math.max(width, codePointCount(r.label));
  for (const r of rows) echo("  " + Style.dim(padEnd(r.label, width)) + "  " + r.value);
}

async function runExplain(a: AppContext, given: string[], kind: ExplainKind | undefined): Promise<void> {
  let names = given;
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
  if ((kind === undefined && names.length === 0) || kind === "machine") {
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
      const entries = machine.scripts.map((entry) => entry.name);
      rows.push({ label: "run", value: entries.join(", ") });
    }
    const data = machine !== undefined ? machine.data : manifest.data;
    const lines = dataLines(data, "");
    for (const line of lines) rows.push({ label: "data." + line.key, value: line.value });
    if (lines.length === 0) echo("  " + Style.dim("no data declared"));
    echoLabelled(rows);
    echo("");
  }

  if (kind === "machine") return;
  // One kind's verb: every item of that kind by default, and a name of
  // another kind points at its own verb.
  if (kind !== undefined && names.length === 0) {
    if (kind === "program") names = [...manifest.programs.keys()];
    else if (kind === "script") names = [...manifest.scripts.keys()];
    else names = (await (a.configs()?.units() ?? Promise.resolve([]))).map((u) => u.name);
    if (names.length === 0) {
      echo(Style.dim("no " + kind + "s in this repo"));
      return;
    }
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
  if (kind !== undefined) {
    const elsewhere: string[] = [];
    explained = explained
      .map((named) => {
        const mine = named.items.filter((item) => item.kind === kind);
        if (mine.length === 0 && named.items.length > 0) {
          const other = named.items[0]!.kind;
          elsewhere.push(named.name + " is a " + other + ": loadout " + other + " explain " + named.name);
        }
        return { ...named, items: mine };
      })
      .filter((named) => named.items.length > 0);
    if (elsewhere.length > 0 && unknown === undefined) unknown = new NoSuchItemError(elsewhere.join("; "), explained);
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
