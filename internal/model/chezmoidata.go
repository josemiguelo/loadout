package model

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

// ChezmoiDataPath is the data file, relative to the repo root, for a repo with configs.
func ChezmoiDataPath(configs string) string { return configs + "/.chezmoidata/loadout.json" }

// ChezmoiPartialPath is the partial, relative to the repo root, for a repo with configs.
func ChezmoiPartialPath(configs string) string {
	return configs + "/.chezmoitemplates/loadout/machine"
}

// ChezmoiPartial picks this machine's table, or the defaults on a machine
// nothing declares. The machine is the one loadout runs as: `LOADOUT_MACHINE`
// (`--machine`'s variable) when set, else the hostname. A machine this
// repo's data lacks may be a child repo's (contract 18): its table then comes
// from the lock of the repo loadout runs on, `LOADOUT_REPO`, so a parent's
// templates render for it under a plain `chezmoi apply` too. The partial
// reads loadout's own lock layout, which no user template may: compile writes
// both, and every load checks the partial is this one.
const ChezmoiPartial = "{{- /* Written by loadout compile; don't edit. This machine's settings (.chezmoidata/loadout.json): " +
	"LOADOUT_MACHINE's, else the hostname's; for a machine this repo doesn't declare, the table in the lock " +
	"of LOADOUT_REPO (a child repo declaring it), else the defaults. " +
	"Use: includeTemplate \"loadout/machine\" . | fromJson */ -}}\n" +
	"{{- $name := env \"LOADOUT_MACHINE\" | default .chezmoi.hostname -}}\n" +
	"{{- $table := get .loadout.machines $name -}}\n" +
	"{{- $repo := env \"LOADOUT_REPO\" -}}\n" +
	"{{- if and (not $table) $repo -}}\n" +
	"{{-   $lock := joinPath $repo \"loadout.lock.json\" -}}\n" +
	"{{-   if stat $lock -}}\n" +
	"{{-     $table = get (get (include $lock | fromJson).manifest.machines $name | default dict) \"data\" -}}\n" +
	"{{-   end -}}\n" +
	"{{- end -}}\n" +
	"{{- $table | default .loadout.defaults | toJson -}}\n"

// ChezmoiDataFiles is each file compile writes for a repo with configs, with its content.
func ChezmoiDataFiles(m Manifest, configs string) Map[string] {
	return MapOf(
		E(ChezmoiDataPath(configs), RenderChezmoiData(m)),
		E(ChezmoiPartialPath(configs), ChezmoiPartial),
	)
}

// RenderChezmoiData is the data file's content: the defaults and every
// machine's table, machines in name order, pretty-printed.
func RenderChezmoiData(m Manifest) string {
	var machines JSONObject
	for name, config := range m.Machines.Sorted().All() {
		machines.Set(name, config.Data)
	}
	loadout := MapOf[any](E[any]("defaults", m.Data), E[any]("machines", machines))
	return PrettyJSON(MapOf[any](E[any]("loadout", loadout))) + "\n"
}
