import { configDrifted } from "../core/coremodel/coremodel.ts";
import * as engine from "../core/engine/index.ts";
import { sortStrings } from "../model/index.ts";
import type { Command } from "./args.ts";
import { exitWith, usageErr } from "./errors.ts";
import type { ProcessRunner } from "../core/exec/index.ts";
import { askForSudoUpfront } from "./converge.ts";
import { boolFlag, commandHelp } from "./help.ts";
import { appCtx, subcommand } from "./root.ts";
import { echo, spinning } from "./spinner.ts";
import { Style } from "./style.ts";

/** newApplyConfigCmd is `loadout config apply`. */
export function newApplyConfigCmd(): Command {
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
  const system = a.detectSystem();

  const { targets, apply } = await withSudo(a.runner, async () => {
    const units = await configs.units();
    const unknown = names.filter((name) => !units.some((u) => u.name === name));
    if (unknown.length > 0) throw usageErr("Unknown configs: " + unknown.join(", ") + " (loadout machine status lists them)");
    let targets: string[] | undefined;
    if (names.length > 0) {
      targets = [];
      for (const u of units) {
        if (names.includes(u.name)) targets.push(...u.targets);
      }
    }
    if (!force) await refuseEdited(configs, targets);
    // What tool folders put outside $HOME is written as root.
    await askForSudoUpfront(a.runner, await configs.rootNeedsSudo(targets));
    return { targets, apply: await configs.applyCommand(targets, force) };
  });
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
 * withSudo runs f, and when a root config couldn't be read without sudo's
 * password, asks for it and runs f again: status calls such configs
 * unknown, but a command that applies them needs them read.
 */
export async function withSudo<T>(runner: ProcessRunner, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (!(e instanceof engine.ConfigNeedsSudoException)) throw e;
    await askForSudoUpfront(runner, true);
    return f();
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
      "keep your edits with `loadout chezmoi re-add`, or replace them with `loadout config apply --force`",
  );
}
