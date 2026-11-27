// What a repo's chezmoi templates get from loadout,
// both written by `loadout compile` beside the lock and checked against it
// on every load, so the dotfiles never render from data the manifests don't
// say:
//
//   - `<configs>/.chezmoidata/loadout.json`, which chezmoi loads into every
//     template as `.loadout`: `loadout.defaults` is every declared key with
//     its default, `loadout.machines.<hostname>` each machine's merged table.
//   - `<configs>/.chezmoitemplates/loadout/machine`, the partial that picks
//     this host's table: `includeTemplate "loadout/machine" . | fromJson`.
//
// The lock's own layout stays loadout's: these two are the contract.

import { type JSONObject, prettyJSON } from "./json.ts";
import type { Manifest } from "./manifest.ts";
import { mapOf, sortedMap } from "./map.ts";

/** chezmoiDataPath is the data file, relative to the repo root, for a repo with configs. */
export function chezmoiDataPath(configs: string): string {
  return configs + "/.chezmoidata/loadout.json";
}

/** chezmoiPartialPath is the partial, relative to the repo root, for a repo with configs. */
export function chezmoiPartialPath(configs: string): string {
  return configs + "/.chezmoitemplates/loadout/machine";
}

/**
 * chezmoiPartial picks this machine's table, or the defaults on a machine
 * nothing declares. The machine is the one loadout runs as: `LOADOUT_MACHINE`
 * (`--machine`'s variable) when set, else the hostname. A machine this
 * repo's data lacks may be a child repo's (contract 18): its table then comes
 * from the lock of the repo loadout runs on, `LOADOUT_REPO`, so a parent's
 * templates render for it under a plain `chezmoi apply` too. The partial
 * reads loadout's own lock layout, which no user template may: compile writes
 * both, and every load checks the partial is this one.
 */
export const chezmoiPartial =
  "{{- /* Written by loadout compile; don't edit. This machine's settings (.chezmoidata/loadout.json): " +
  "LOADOUT_MACHINE's, else the hostname's; for a machine this repo doesn't declare, the table in the lock " +
  "of LOADOUT_REPO (a child repo declaring it), else the defaults. " +
  'Use: includeTemplate "loadout/machine" . | fromJson */ -}}\n' +
  '{{- $name := env "LOADOUT_MACHINE" | default .chezmoi.hostname -}}\n' +
  "{{- $table := get .loadout.machines $name -}}\n" +
  '{{- $repo := env "LOADOUT_REPO" -}}\n' +
  "{{- if and (not $table) $repo -}}\n" +
  '{{-   $lock := joinPath $repo "loadout.lock.json" -}}\n' +
  "{{-   if stat $lock -}}\n" +
  '{{-     $table = get (get (include $lock | fromJson).manifest.machines $name | default dict) "data" -}}\n' +
  "{{-   end -}}\n" +
  "{{- end -}}\n" +
  "{{- $table | default .loadout.defaults | toJson -}}\n";

/** chezmoiDataFiles is each file compile writes for a repo with configs, with its content. */
export function chezmoiDataFiles(m: Manifest, configs: string): Map<string, string> {
  return mapOf([chezmoiDataPath(configs), renderChezmoiData(m)], [chezmoiPartialPath(configs), chezmoiPartial]);
}

/**
 * renderChezmoiData is the data file's content: the defaults and every
 * machine's table, machines in name order, pretty-printed.
 */
export function renderChezmoiData(m: Manifest): string {
  const machines: JSONObject = new Map();
  for (const [name, config] of sortedMap(m.machines)) machines.set(name, config.data);
  const loadout: JSONObject = mapOf(["defaults", m.data], ["machines", machines]);
  return prettyJSON(mapOf(["loadout", loadout])) + "\n";
}
