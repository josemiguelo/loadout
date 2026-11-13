import { configDrifted } from "../core/coremodel/coremodel.ts";
import * as engine from "../core/engine/index.ts";
import { sortStrings } from "../model/index.ts";
import type { Command } from "./args.ts";
import { exitWith, usageErr } from "./errors.ts";
import { boolFlag, commandHelp } from "./help.ts";
import { appCtx, subcommand } from "./root.ts";
import { echo, ensureBun, spinning } from "./spinner.ts";
import { Style } from "./style.ts";

/** newApplyCmd is `loadout apply`. */
export function newApplyCmd(): Command {
  const cmd = subcommand(
    "apply",
    commandHelp(
      "Write the repo's configs to this machine (chezmoi apply), then refresh its state.",
      "<configs...>  config names as status lists them (default: all)",
      "--force       also replace files edited on this machine",
    ),
    [{ name: "configs", help: "Config names, as status lists them", optional: true, multiple: true }],
    (_cmd, args, flags) => runApply(args, flags.bool("force")),
  );
  boolFlag(cmd, "force", "", "Replace files edited on this machine");
  return cmd;
}

async function runApply(names: string[], force: boolean): Promise<void> {
  const a = appCtx();
  const configs = a.configs();
  if (configs === undefined) throw new engine.ConfigException("this repo has no configs (layout configs)");
  const manifest = a.loadManifest();
  await ensureBun(a, manifest);
  const system = a.detectSystem();

  const units = await configs.units();
  const unknown = names.filter((name) => !units.some((u) => u.name === name));
  if (unknown.length > 0) throw usageErr("Unknown configs: " + unknown.join(", ") + " (loadout status lists them)");
  let targets: string[] | undefined;
  if (names.length > 0) {
    targets = [];
    for (const u of units) {
      if (names.includes(u.name)) targets.push(...u.targets);
    }
  }
  if (!force) await refuseEdited(configs, targets);

  const apply = await configs.applyCommand(targets, force);
  const code = await a.runner.inherit(apply);
  if (code !== 0) throw new engine.ConfigException("chezmoi apply failed (exit " + code + ")");

  const after = await spinning("updating state…", () => a.refreshAndWriteState(manifest, system, new Map()));
  const applied = names.length > 0 ? names : [...after.configs.keys()];
  const stillDrifted: string[] = [];
  for (const name of applied) {
    const c = after.configs.get(name);
    if (c !== undefined && c.status === configDrifted && !stillDrifted.includes(name)) stillDrifted.push(name);
  }
  sortStrings(stillDrifted);
  const what = names.length > 0 ? names.join(", ") : "every config";
  echo(" " + Style.ok("✔") + "  applied " + what);
  if (stillDrifted.length > 0) {
    echo(" " + Style.warn("!") + "  still drifted: " + stillDrifted.join(", "));
    throw exitWith(1);
  }
}

/**
 * refuseEdited stops when a file apply would replace (targets; undefined =
 * all) was edited on this machine: chezmoi would ask, and only the user
 * knows which version to keep.
 */
export async function refuseEdited(configs: engine.ConfigEngine, targets: readonly string[] | undefined): Promise<void> {
  const edited = await configs.edited(targets);
  if (edited.length === 0) return;
  throw new engine.ConfigException(
    edited.length + " config file(s) edited on this machine: " + edited.join(", ") + " — " +
      "keep your edits with `chezmoi re-add`, or replace them with `loadout apply --force`",
  );
}
