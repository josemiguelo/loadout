import { type AppContext, home, latestRelease, shQuote } from "../app/index.ts";
import { done, type MachineState, missing } from "../core/coremodel/coremodel.ts";
import * as engine from "../core/engine/index.ts";
import { line, success } from "../core/exec/index.ts";
import { GitException, newGitClient } from "../core/git/git.ts";
import * as loader from "../core/loader/loader.ts";
import { envVar, selfExecutable } from "../core/platform/platform.ts";
import { chezmoiDataFiles, lockFileName, Refusal, ToolTooOldException, trimSpace } from "../model/index.ts";
import { atLeast, installCommand, VERSION } from "../version.ts";
import { refuseEdited } from "./apply.ts";
import type { Command } from "./args.ts";
import { compileRepo } from "./compile.ts";
import { exitWith } from "./errors.ts";
import { boolFlag, commandHelp, stringFlag } from "./help.ts";
import { appCtx, subcommand } from "./root.ts";
import { echo, spin, spinning } from "./spinner.ts";
import { Style } from "./style.ts";

/** syncUpgraded is set on the sync an upgrade starts. */
const syncUpgraded = "LOADOUT_SYNC_UPGRADED";
/**
 * syncRecompiled is set on the sync an upgrade starts when the sync before
 * it compiled the lock.
 */
const syncRecompiled = "LOADOUT_SYNC_RECOMPILED";

/**
 * SyncException is a sync that couldn't carry on after the pulled repo
 * needed a newer loadout.
 */
export class SyncException extends Refusal {}

/** newSyncCmd is `loadout sync`. */
export function newSyncCmd(): Command {
  const cmd = subcommand(
    "sync",
    commandHelp(
      "Pull the config repo, apply its configs, refresh this machine's state, commit only its state file, push. " +
        "When the pulled repo needs a newer loadout, upgrade loadout first and carry on with it. " +
        "A child repo pulls its parent first (never commits or pushes it), and recompiles itself when the " +
        "parent's manifests changed, committing the lock with the state.",
      "--no-push       commit locally, don't push",
      "-m, --message   override the commit message",
    ),
    [],
    (_cmd, _args, flags) =>
      runSync(appCtx(), flags.bool("no-push"), flags.changed("message") ? flags.string("message") : undefined),
  );
  boolFlag(cmd, "no-push", "", "Commit locally but don't push");
  stringFlag(cmd, "message", "m", "", "Commit message");
  return cmd;
}

/** attempt is f's value, or the ToolTooOldException it threw (anything else is rethrown). */
function attempt<T>(f: () => T): { value: T } | { tooOld: ToolTooOldException } {
  try {
    return { value: f() };
  } catch (e) {
    if (e instanceof ToolTooOldException) return { tooOld: e };
    throw e;
  }
}

async function runSync(a: AppContext, noPush: boolean, message: string | undefined): Promise<void> {
  const repo = newGitClient(a.runner, a.repoRoot);
  if (!(await repo.isRepo())) {
    throw new GitException(a.repoRoot + " is not a git repository (run `loadout init` or `git init` first)");
  }

  // A child repo (contract 18): the parent is pulled, nothing more. A lock
  // this loadout can't read yet waits for the upgrade below, whose sync
  // pulls it.
  const parent = attempt(() => a.parentRoot());
  const parentRoot = "value" in parent ? parent.value : "";
  if (parentRoot !== "") {
    const parentGit = newGitClient(a.runner, parentRoot);
    if ((await parentGit.isRepo()) && (await parentGit.hasUpstream())) {
      await spin("pulling parent " + parentName(a) + "…", () => parentGit.pullRebase());
    }
  }

  const hasUpstream = await repo.hasUpstream();
  if (hasUpstream) await spin("pulling latest changes…", () => repo.pullRebase());
  else echo(Style.dim("No upstream configured; skipping pull."));

  // A parent whose manifests moved needs the child compiled against them;
  // a compile that fails stops here with what it said. It reads the lock,
  // so a repo that now needs a newer loadout says so here first.
  const changed = attempt(() => loader.parentChanged(a.repoRoot, home()));
  if ("tooOld" in changed) return upgradeAndSyncAgain(a, changed.tooOld, false, noPush, message);
  const compiledNow = changed.value;
  if (compiledNow) {
    echo(" " + Style.warn("↻") + "  parent " + parentName(a) + " changed: compiling");
    await compileRepo(a);
  }
  // A sync an upgrade started finds the lock already compiled by the sync
  // before it, and still commits it.
  const recompiled = compiledNow || envVar(syncRecompiled) !== undefined;

  // Load after pulling so we see the latest manifest, and read the layout
  // again: the pull or the compile can rename its folders.
  a.reloadLayout();
  const loaded = attempt(() => a.loadManifest());
  if ("tooOld" in loaded) return upgradeAndSyncAgain(a, loaded.tooOld, recompiled, noPush, message);
  const manifest = loaded.value;
  const system = a.detectSystem();
  // Configs land before the refresh, so the state committed is what this
  // machine has after the pull. A file edited here stops the sync before
  // anything is written: only the user knows which version wins.
  const configs = a.configs();
  if (configs !== undefined) {
    await refuseEdited(configs, undefined);
    const apply = await configs.applyCommand(undefined, false);
    const result = await spinning("applying configs…", () => a.runner.capture(apply));
    if (!success(result)) {
      let why = " (exit " + result.exitCode + ")";
      for (const l of [...result.stderr.split("\n"), ...result.stdout.split("\n")]) {
        if (trimSpace(l) !== "") {
          why = ": " + trimSpace(l);
          break;
        }
      }
      throw new engine.ConfigException("chezmoi apply failed" + why);
    }
    echo(" " + Style.ok("✔") + "  configs applied");
  }
  const observed = await spinning(Style.dim("refreshing state for ") + Style.machine(system.machine), () =>
    a.refreshAndWriteState(manifest, system, new Map()),
  );
  const left = leftToDo(observed);
  if (left !== "") echo(" " + Style.warn("⚠") + "  " + Style.warn(left) + Style.dim("  (run: loadout)"));

  const layout = a.layout();
  const statePath = layout.state + "/" + system.machine + ".json";
  // A recompile's lock (and the templates' data beside the configs) goes
  // with the state.
  const paths: string[] = [];
  let defaultMessage = system.machine + ": update state";
  if (recompiled) {
    paths.push(lockFileName);
    if (manifest.layout.configs !== undefined) paths.push(...chezmoiDataFiles(manifest, manifest.layout.configs).keys());
    defaultMessage = system.machine + ": compile against parent " + parentName(a) + ", update state";
  }
  paths.push(statePath);
  const committed = await repo.addCommit(paths, message ?? defaultMessage);
  if (!committed) {
    echo(" " + Style.ok("✔") + "  state unchanged; nothing to commit");
    return;
  }
  echo(" " + Style.ok("✔") + "  committed " + paths.join(", "));

  if (noPush) {
    echo(Style.dim("Skipping push (--no-push)."));
  } else if (!hasUpstream) {
    echo("No upstream configured; not pushing. Add a remote and run `git push -u`.");
  } else {
    await spin("pushing…", () => repo.push());
    echo(" " + Style.ok("✔") + "  pushed");
  }
}

/** parentName is the parent's name, ("null" when it has none). */
function parentName(a: AppContext): string {
  try {
    const layout = a.layout();
    if (layout.parent !== undefined) return layout.parent.name;
  } catch {
    // "null", as below.
  }
  return "null";
}

/**
 * upgradeAndSyncAgain: the pulled repo needs a newer loadout, so install the
 * latest release, then run this same sync with it. The second run pulls
 * again (nothing new) and carries on; syncUpgraded keeps it from upgrading a
 * second time when the binary it runs is still too old (one self-upgrade
 * didn't replace). recompiled: this sync compiled the lock, so the one it
 * starts commits it.
 */
async function upgradeAndSyncAgain(
  a: AppContext,
  refusal: ToolTooOldException,
  recompiled: boolean,
  noPush: boolean,
  message: string | undefined,
): Promise<void> {
  if (envVar(syncUpgraded) !== undefined) {
    const self = selfExecutable() || "this binary";
    throw new SyncException(
      "loadout was upgraded, but " + self + " is still " + VERSION + "; this config repo requires loadout >= " + refusal.required,
    );
  }
  const latest = await latestRelease(a.runner, false);
  if (latest !== "" && !atLeast(latest, refusal.required)) {
    throw new SyncException("this config repo requires loadout >= " + refusal.required + ", but the latest release is " + latest);
  }
  // Read before the install replaces the file: Linux then names it "(deleted)".
  const self = selfExecutable();
  if (self === "") throw new SyncException("can't find loadout's own binary to run the sync again");
  echo(" " + Style.warn("↑") + "  this config repo now needs loadout >= " + refusal.required + " (you have " + VERSION + "): upgrading");
  const installed = await a.runner.inherit(line(installCommand, ""));
  if (installed !== 0) throw exitWith(installed);
  echo(" " + Style.ok("✔") + "  loadout upgraded; syncing with it");
  const args = ["sync"];
  if (noPush) args.push("--no-push");
  if (message !== undefined) args.push("--message", message);
  const argv = a.selfArgv(self, ...args);
  let env = syncUpgraded + "=1 ";
  if (recompiled) env += syncRecompiled + "=1 ";
  const code = await a.runner.inherit(line(env + argv.map(shQuote).join(" "), ""));
  if (code !== 0) throw exitWith(code);
}

/** leftToDo is what this machine still lacks after the sync, or "" when nothing. */
export function leftToDo(s: MachineState): string {
  let missingCount = 0;
  let scripts = 0;
  for (const p of s.programs.values()) if (p.status === missing) missingCount++;
  for (const sc of s.scripts.values()) if (sc.status !== done) scripts++;
  const parts: string[] = [];
  if (missingCount > 0) parts.push(missingCount + " " + (missingCount === 1 ? "program" : "programs") + " missing");
  if (scripts > 0) parts.push(scripts + " " + (scripts === 1 ? "script" : "scripts") + " not done");
  return parts.join(" · ");
}
