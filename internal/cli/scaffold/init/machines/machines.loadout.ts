// Machines, by hostname, and the profiles they share. A machine installs
// only what it (or a profile it extends) names, and runs only the scripts
// it names.
import { machine } from "loadout";
import type { Data } from "./data.ts";
// import { dnf, via } from "loadout";
// import { ripgrep } from "../programs/cli.loadout.ts";

machine<Data>("{{.Hostname}}", {
  // Pick how this machine installs ripgrep, then uncomment (and the imports):
  // install: [via(dnf, [ripgrep])],
});
