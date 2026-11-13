import { scriptOrder } from "../assemble/index.ts";
import { done, failed, type ScriptState } from "../core/coremodel/coremodel.ts";
import * as engine from "../core/engine/index.ts";
import { cut, scriptArgs, sortStrings } from "../model/index.ts";
import type { Command } from "./args.ts";
import { askForSudoUpfront, machineOf } from "./converge.ts";
import { exitWith, usageErr } from "./errors.ts";
import { boolFlag, commandHelp } from "./help.ts";
import { appCtx, subcommand } from "./root.ts";
import { exitText } from "./setup.ts";
import { echo, spinning } from "./spinner.ts";
import { Style } from "./style.ts";

/** newRunCmd is `loadout run`. */
export function newRunCmd(): Command {
  const cmd = subcommand(
    "run",
    commandHelp(
      "Run the named scripts from the manifest.",
      "<scripts...>  script names (must be opted in by this machine)",
      "--all         every script this machine opts into, instead of names",
      "--force       run even when the check already passes",
    ),
    [{ name: "scripts", help: "Script names from the manifest", optional: true, multiple: true }],
    (_cmd, args, flags) => runScripts(args, flags.bool("all"), flags.bool("force")),
  );
  boolFlag(cmd, "all", "", "Run every script this machine opts into (modes ignored, like any run)");
  boolFlag(cmd, "force", "", "Run even if the script's check passes");
  return cmd;
}

async function runScripts(names: string[], all: boolean, force: boolean): Promise<void> {
  const a = appCtx();
  const manifest = a.loadManifest();
  const system = a.detectSystem();
  if (all && names.length > 0) throw usageErr("Give script names or --all, not both");
  if (!all && names.length === 0) throw usageErr("Give at least one script, or --all");
  const unknown = names.filter((name) => !manifest.scripts.has(name));
  if (unknown.length > 0) throw usageErr("Unknown scripts: " + unknown.join(", "));
  const enabled = scriptArgs(machineOf(manifest, system.machine));
  let disabled = false;
  for (const name of names) {
    if (!enabled.has(name)) {
      echo(
        "error: script '" + name + "' is not run on machine '" + system.machine + "' " +
          "(run it in machine '" + system.machine + "' or a profile it extends)",
      );
      disabled = true;
    }
  }
  if (disabled) throw exitWith(1);

  // --all is the machine's opt-in list itself — membership, not modes:
  // `run` is the explicit escape hatch and ignores setup/maintain. Acting
  // on the last status's verdict is the home screen's job (its scripts row
  // pre-ticks what isn't done); here you name what you want.
  const targets = all ? [...enabled.keys()] : names;
  if (targets.length === 0) {
    echo(Style.dim("No scripts opted in for " + system.machine + "."));
    return;
  }

  const frame = await a.frame(system);
  const runner = engine.newScriptRunner(a.runner, frame);
  const ordered = scriptOrder(manifest, targets).filter((name) => targets.includes(name));
  let needsSudo = false;
  for (const name of ordered) {
    const step = manifest.scripts.get(name)!;
    const args = enabled.get(name) ?? "";
    if (runner.needsSudo(step, args) && (await runner.pending(step, force, args))) {
      needsSudo = true;
      break;
    }
  }
  await askForSudoUpfront(a.runner, needsSudo);
  const results = new Map<string, ScriptState>();
  for (const name of ordered) {
    const outcome = await runner.run(manifest.scripts.get(name)!, force, enabled.get(name) ?? "");
    if (outcome.alreadyDone) {
      echo(" " + Style.ok("✔") + "  skipped " + name + " " + Style.dim("(already done; use --force to run anyway)"));
      continue;
    }
    const state = outcome.state!;
    const mark = state.exitCode === 0 ? Style.ok("✔") : Style.error("✘");
    echo(" " + mark + "  ran " + name + " (exit " + exitText(state.exitCode) + ")");
    results.set(name, state);
  }

  if (results.size > 0) {
    const after = await spinning("updating state…", () => a.refreshAndWriteState(manifest, system, results));
    echo(Style.dim("State updated."));
    // The check decides, not the exit code: name scripts still pending,
    // with the first line their check printed.
    const stillNot: string[] = [];
    for (const [name, now] of after.scripts) {
      if (results.has(name) && now.status !== done) stillNot.push(name);
    }
    sortStrings(stillNot);
    if (stillNot.length > 0) {
      const detail = a.lastScriptDetail();
      const named = stillNot.map((name) => {
        const d = detail.get(name);
        return d === undefined ? name : name + " (" + cut(d, "\n")[0] + ")";
      });
      echo(" " + Style.warn("!") + "  still not done: " + named.join(", "));
    }
  }
  for (const s of results.values()) {
    if (s.status === failed) throw exitWith(1);
  }
}
