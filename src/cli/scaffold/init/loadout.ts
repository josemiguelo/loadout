// The repo: its name, where loadout writes each machine's state, and the
// manifests it includes. Every declaration is an exported, typed reference:
// a file imports what it uses from the file that declares it.
import { include, repo } from "loadout";
import { schema } from "./machines/data.ts";

// Every manifest under these folders (globs match dot files too), then the
// machines. A new file needs no import here.
await include("programs/**/*.loadout.ts", "maintenance/**/*.loadout.ts", "machines/**/*.loadout.ts");

repo({
  name: "my machines",
  state: "machines/state",
  data: schema,
});
