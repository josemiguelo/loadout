// A child repo of {{.ParentName}}: its machines use {{.ParentName}}'s programs, scripts,
// profiles and data, imported from its checkout ("parent/…", see
// tsconfig.json), and add their own. Nothing here goes into {{.ParentName}}; its
// data schema is {{.ParentName}}'s.
import { include, repo } from "loadout";

await include("programs/**/*.loadout.ts", "maintenance/**/*.loadout.ts", "machines/**/*.loadout.ts");

repo({
  name: "my machines",
  state: "machines/state",
  // The repo this one builds on.
  parent: { name: "{{.ParentName}}", path: "{{.ParentPath}}" },
});
