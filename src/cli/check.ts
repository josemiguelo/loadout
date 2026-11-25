import { scriptOrder } from "../assemble/index.ts";
import * as engine from "../core/engine/index.ts";
import { optionsWord, parseJSON, scriptOptions } from "../model/index.ts";
import type { Command } from "./args.ts";
import { machineOf } from "./converge.ts";
import { exitWith, usageErr } from "./errors.ts";
import { boolFlag, commandHelp, stringFlag } from "./help.ts";
import { appCtx, subcommand } from "./root.ts";
import { echo } from "./spinner.ts";
import { Style } from "./style.ts";

/** newCheckCmd is `loadout check`. */
export function newCheckCmd(): Command {
  const cmd = subcommand(
    "check",
    commandHelp(
      "Ask scripts whether they're done, without running them.",
      "<scripts...>  script names (must be opted in by this machine)",
      "--all         every script this machine opts into, instead of names",
      "--options     JSON to ask one module script with, instead of the machine's",
    ),
    [{ name: "scripts", help: "Script names from the manifest", optional: true, multiple: true }],
    (_cmd, args, flags) => checkScripts(args, flags.bool("all"), flags.string("options")),
  );
  boolFlag(cmd, "all", "", "Check every script this machine opts into");
  stringFlag(cmd, "options", "", "", "Options to check one module script with, as JSON");
  return cmd;
}

/** checkScripts prints each script's answer; exits 1 unless all are done. It writes nothing. */
async function checkScripts(names: string[], all: boolean, options: string): Promise<void> {
  const a = appCtx();
  const manifest = a.loadManifest();
  const system = a.detectSystem();
  if (all && names.length > 0) throw usageErr("Give script names or --all, not both");
  if (!all && names.length === 0) throw usageErr("Give at least one script, or --all");
  const unknown = names.filter((name) => !manifest.scripts.has(name));
  if (unknown.length > 0) throw usageErr("Unknown scripts: " + unknown.join(", "));
  const enabled = scriptOptions(machineOf(manifest, system.machine));
  if (options !== "") {
    if (names.length !== 1 || manifest.scripts.get(names[0]!)!.rules === undefined) throw usageErr("--options goes with one script that takes options");
    let parsed;
    try {
      parsed = parseJSON(options);
    } catch {
      throw usageErr("--options isn't valid JSON");
    }
    enabled.set(names[0]!, optionsWord(parsed));
  }
  const off = names.filter((name) => !enabled.has(name));
  if (off.length > 0) {
    for (const name of off) {
      echo(
        "error: script '" + name + "' is not run on machine '" + system.machine + "' " +
          "(run it in machine '" + system.machine + "' or a profile it extends)",
      );
    }
    throw exitWith(1);
  }
  const targets = all ? [...enabled.keys()] : names;
  const runner = engine.newScriptRunner(a.runner, await a.frame(system));
  const ordered = scriptOrder(manifest, targets).filter((name) => targets.includes(name));
  const answers = await engine.forEach(ordered.length, engine.parallelism, (i) =>
    runner.check(manifest.scripts.get(ordered[i]!)!, enabled.get(ordered[i]!)!),
  );
  let allDone = true;
  ordered.forEach((name, i) => {
    const answer = answers[i];
    if (answer?.done !== true) allDone = false;
    const mark = answer === undefined ? Style.warn("?") : answer.done ? Style.ok("✔") : Style.error("✘");
    echo(" " + mark + "  " + name + "  " + Style.dim(answer === undefined ? "has no check" : answer.done ? "done" : "not done"));
    if (answer !== undefined && answer.output !== "") for (const line of answer.output.split("\n")) echo("      " + line);
  });
  if (!allDone) throw exitWith(1);
}
