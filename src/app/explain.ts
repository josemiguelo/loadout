// What `explain` says about a program, script or config — the fully expanded
// definition as the engine sees it, plus this machine's last observation —
// as data: the CLI prints it, the home screen's inspector shows it.

import { configDrifted } from "../core/coremodel/coremodel.ts";
import type { ConfigUnit } from "../core/engine/index.ts";
import {
  isParentOrigin,
  modeList,
  originFolder,
  Refusal,
  resolveInstall,
  scriptArgs,
  slicesEqual,
  type VersionCheck,
  versionCheckEqual,
} from "../model/index.ts";
import type { AppContext } from "./context.ts";

/**
 * ExplainRow is one `label  value` line. machine is set on the install
 * variant this machine uses (its name): the CLI marks it `<- machine`.
 */
export interface ExplainRow {
  label: string;
  value: string;
  machine: string;
}

/** Explained is one program, script or config. */
export interface Explained {
  /** kind is "program", "script" or "config". */
  kind: string;
  name: string;
  description: string;
  /**
   * folder is where it is declared, from the repo's root ("" = the root);
   * a config's is the configs directory.
   */
  folder: string;
  rows: ExplainRow[];
  /** notes are warnings after the rows ("! not installed on m1 …"). */
  notes: string[];
}

/**
 * ExplainedName is everything a name explains: a program or a script, and a
 * config of the same name (tmux the program, tmux the config).
 */
export interface ExplainedName {
  name: string;
  items: Explained[];
}

/**
 * NoSuchItemError is a name explain doesn't know. explained is what came
 * before it: the CLI prints it, then the error.
 */
export class NoSuchItemError extends Refusal {
  constructor(
    message: string,
    readonly explained: ExplainedName[],
  ) {
    super(message);
  }
}

function row(label: string, value: string): ExplainRow {
  return { label, value, machine: "" };
}

/**
 * explain explains names (none: every program and script). Configs are asked
 * about (chezmoi) only for names given. An unknown name stops it with a
 * NoSuchItemError, carrying what came before it.
 */
export async function explain(a: AppContext, names: readonly string[]): Promise<ExplainedName[]> {
  const manifest = a.loadManifest();
  const layout = a.layout();
  const system = a.detectSystem();
  const store = a.stateStore();
  const observed = store.read(system.machine);
  const machine = manifest.machines.get(system.machine);
  const declared = machine !== undefined;
  const mapping = machine?.pm ?? new Map<string, string>();
  const parentName = layout.parent !== undefined ? layout.parent.name : "null";
  const statePath = layout.state + "/" + system.machine + ".json";

  let targets = [...names];
  if (targets.length === 0) targets = [...manifest.programs.keys(), ...manifest.scripts.keys()];
  let units: ConfigUnit[] = [];
  let askErr: unknown;
  if (names.length > 0) {
    try {
      const configs = a.configs();
      if (configs !== undefined) units = await configs.units();
    } catch (e) {
      askErr = e;
      units = [];
    }
  }
  const unitNamed = (name: string): ConfigUnit | undefined => units.find((u) => u.name === name);
  const fromParent = (origin: string): string | undefined => {
    if (!isParentOrigin(origin)) return undefined;
    let folder = originFolder(origin);
    if (folder === "") folder = "its root";
    return "parent " + parentName + " (" + folder + ")";
  };

  const out: ExplainedName[] = [];
  for (const name of targets) {
    const program = manifest.programs.get(name);
    const script = manifest.scripts.get(name);
    const unit = unitNamed(name);
    if (program === undefined && script === undefined && unit === undefined) {
      const kinds = a.hasConfigs() ? "program, script or config" : "program or script";
      const why = askErr !== undefined ? " (configs not checked: " + errorText(askErr) + ")" : "";
      throw new NoSuchItemError("no " + kinds + " named '" + name + "'" + why, out);
    }
    const named: ExplainedName = { name, items: [] };
    if (program !== undefined) {
      const item: Explained = {
        kind: "program",
        name,
        description: program.description,
        folder: originFolder(program.origin),
        rows: [],
        notes: [],
      };
      const rows: ExplainRow[] = [];
      const add = (label: string, value: string) => rows.push(row(label, value));
      const from = fromParent(program.origin);
      if (from !== undefined) add("from", from);
      if (program.version !== undefined) add("version", describeCheck(program.version));
      else add("version", "(none — status will always be 'unknown')");
      if (program.dependsOn.length > 0) add("depends-on", program.dependsOn.join(", "));
      if (program.path.length > 0) add("path", program.path.join(":") + "  (first on PATH for its commands)");
      if (program.tags.length > 0) add("tags", program.tags.join(", "));
      if (program.later !== "") add("later", program.later + "  (setup-new-machine installs it after everything else)");
      if (program.install.size === 0) add("install", "(none — not installable anywhere)");
      const mappedKey = mapping.get(name);
      const isMapped = mappedKey !== undefined;
      for (const [key, variant] of program.install) {
        const resolved = resolveInstall(manifest, name, key);
        let installer = "";
        if (variant.installer !== undefined) installer = variant.installer;
        else if (manifest.installers.has(key)) installer = key;
        // Where the mechanics came from: loadout's library or this repo.
        let via = "";
        if (installer !== "") {
          let origin = "repo";
          if (manifest.builtinInstallers.includes(installer)) origin = "built-in";
          else if (isParentOrigin(manifest.installers.get(installer)?.origin ?? "")) origin = "parent " + parentName;
          via = "  [installer: " + installer + " (" + origin + ")]";
        }
        const command = resolved.command ?? "null";
        const r = row("install." + key, command + via);
        if (isMapped && key === mappedKey) r.machine = system.machine;
        rows.push(r);
        if (resolved.check !== undefined && !versionCheckEqual(resolved.check, program.version)) {
          add("check." + key, describeCheck(resolved.check));
        }
        if (resolved.probe !== undefined) add("probe." + key, resolved.probe);
        if (resolved.sudo) add("sudo." + key, "yes — a run that installs it asks for the password first");
        if (variant.dependsOn.length > 0) add("depends-on." + key, variant.dependsOn.join(", "));
        if (variant.provides.length > 0) {
          const provides = variant.provides.map((p) => (p.at !== undefined ? p.binary + " (in " + p.at + ")" : p.binary));
          add("provides." + key, provides.join(", "));
        }
      }
      if (!isMapped) {
        item.notes.push(
          "! not installed on " + system.machine + " (install it in machine '" + system.machine + "' or a profile it extends)",
        );
      }
      const p = observed?.programs.get(name);
      if (p !== undefined) {
        const version = p.version !== undefined ? " " + p.version : "";
        add("observed", p.status + version + "  (" + statePath + ")");
      }
      item.rows = rows;
      named.items.push(item);
    } else if (script !== undefined) {
      const item: Explained = {
        kind: "script",
        name,
        description: script.description,
        folder: originFolder(script.origin),
        rows: [],
        notes: [],
      };
      const rows: ExplainRow[] = [];
      const add = (label: string, value: string) => rows.push(row(label, value));
      const from = fromParent(script.origin);
      if (from !== undefined) add("from", from);
      if (script.file !== undefined) add("file", script.file);
      if (script.run !== undefined) add("run", script.run);
      if (script.check !== undefined) add("check", script.check);
      if (script.variants.size > 0) add("variants", [...script.variants.keys()].join(", "));
      if (script.after.length > 0) add("after", script.after.join(", "));
      const modes = modeList(script);
      if (!slicesEqual(modes, ["setup", "maintain"])) add("modes", modes.join(", "));
      if (script.later !== "") add("later", script.later + "  (setup-new-machine runs it after everything else)");
      if (script.sudo) add("sudo", "yes — a run that runs it asks for the password first");
      const args = machine !== undefined ? scriptArgs(machine).get(name) : undefined;
      if (!declared || args === undefined) {
        add("enabled", "no — run it in machine '" + system.machine + "' or a profile it extends");
      } else if (args === "") {
        add("enabled", "yes (" + system.machine + ")");
      } else {
        add("enabled", "yes (" + system.machine + ", args: " + args + ")");
      }
      const s = observed?.scripts.get(name);
      if (s !== undefined) add("observed", s.status + "  (" + statePath + ")");
      item.rows = rows;
      named.items.push(item);
    }
    if (unit !== undefined) {
      const configsDir = layout.configs ?? "null";
      const item: Explained = { kind: "config", name, description: "", folder: configsDir + "/", rows: [], notes: [] };
      unit.targets.forEach((target, i) => item.rows.push(row(i === 0 ? "targets" : "", target)));
      const c = observed?.configs.get(name);
      if (c !== undefined) {
        let status: string = c.status;
        if (c.status === configDrifted) status = "drifted: " + c.files.join(", ");
        item.rows.push(row("observed", status + "  (" + statePath + ")"));
      }
      named.items.push(item);
    }
    out.push(named);
  }
  return out;
}

/**
 * describeCheck is a check as explain shows it: its command and what reads
 * the version, or that it only says yes or no.
 */
export function describeCheck(check: VersionCheck): string {
  if (check.regex !== undefined) return check.command + "  =~ /" + check.regex + "/";
  return check.command + "  (yes/no)";
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
