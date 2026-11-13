import type { Command } from "./args.ts";
import { usageErr } from "./errors.ts";
import { echoLabelled, type Row } from "./explain.ts";
import { commandHelp } from "./help.ts";
import { appCtx, subcommand } from "./root.ts";
import { echo } from "./spinner.ts";
import { sortedKeys } from "./status.ts";
import { Style } from "./style.ts";
import { padEnd, runeCount } from "./table.ts";

/**
 * newInstallersCmd is what `install_via = [dnf]` actually means. Installers
 * ship with loadout and are merged under the repo's own, so this is where
 * you see which definition won. To own a built-in, declare an installer of
 * the same name.
 */
export function newInstallersCmd(): Command {
  return subcommand(
    "installers",
    commandHelp(
      "Show the install mechanisms available to this repo: loadout's built-ins plus your own.",
      "[name]     print one installer's full definition",
    ),
    [{ name: "name", help: "Installer to describe", optional: true }],
    (_cmd, args) => runInstallers(args),
  );
}

async function runInstallers(args: string[]): Promise<void> {
  const manifest = appCtx().loadManifest();
  // Style AFTER padding — escape codes would break the column width.
  const source = (key: string, width: number) =>
    manifest.builtinInstallers.includes(key) ? Style.dim(padEnd("built-in", width)) : Style.machine(padEnd("repo", width));

  if (args.length === 1) {
    const single = args[0]!;
    const installer = manifest.installers.get(single);
    if (installer === undefined) throw usageErr("Unknown installer '" + single + "' (see: loadout installers)");
    echo(Style.header("installer ") + Style.bold(single) + "  " + source(single, 0));
    const rows: Row[] = [];
    const add = (label: string, value: string | undefined) => {
      if (value !== undefined) rows.push({ label, value });
    };
    add("probe", installer.probe);
    if (installer.params.length > 0) rows.push({ label: "params", value: installer.params.join(", ") });
    add("install", installer.install);
    add("upgrade", installer.upgrade);
    if (installer.sudo) rows.push({ label: "sudo", value: "yes — a run that installs or upgrades through it asks for the password first" });
    add("check", installer.check);
    add("regex", installer.regex);
    add("outdated", installer.outdated);
    add("outdated-all", installer.outdatedAll);
    if (installer.requires.length > 0) rows.push({ label: "requires", value: installer.requires.join(", ") });
    echoLabelled(rows);
    return;
  }

  const names = sortedKeys(manifest.installers);
  if (names.length === 0) {
    echo("No installers.");
    return;
  }
  let nameWidth = 9;
  for (const n of names) nameWidth = Math.max(nameWidth, runeCount(n));
  nameWidth += 2;
  echo(Style.header("  " + padEnd("INSTALLER", nameWidth) + "SOURCE    INSTALL"));
  for (const key of names) {
    const install = manifest.installers.get(key)!.install ?? "(no install command)";
    echo("  " + padEnd(key, nameWidth) + source(key, 10) + Style.dim(install));
  }
  echo("");
  echo(Style.dim("  A repo installer of the same name replaces the built-in."));
}
