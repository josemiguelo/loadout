// This repo's machines: by hostname, extending {{.ParentName}}'s profiles, imported
// from its checkout.
import { machine } from "loadout";
// import { aProfile } from "parent/machines/profiles/a.profile.loadout.ts";

machine("{{.Hostname}}", {
  // extends: [aProfile],
});
