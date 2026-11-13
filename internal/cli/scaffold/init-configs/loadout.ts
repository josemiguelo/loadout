// The repo: its name, where loadout writes each machine's state, chezmoi's
// source (loadouts/), and the manifests it includes. A tool's manifest sits
// where its files land in your home, beside its dotfiles, or as a dot file
// chezmoi never deploys; what lands outside your home and belongs to no
// tool is a folder per concern in loadouts/.etc/. Every declaration is an
// exported, typed reference: a file imports what it uses from the file that
// declares it.
import { include, repo } from "loadout";
import { schema } from "./machines/data.ts";

// Every manifest under loadouts/ (globs match dot files and folders too),
// then the machines. A new file needs no import here.
await include("loadouts/**/*.loadout.ts", "machines/**/*.loadout.ts");

repo({
  name: "my machines",
  state: "machines/state",
  configs: "loadouts",
  data: schema,
});
