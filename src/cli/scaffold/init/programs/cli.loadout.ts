// Programs. A program says which installers can install it; a machine
// picks one. `loadout program explain ripgrep` shows what it resolves to. Paths a
// file names (scripts, `runFile()` commands) are relative to its folder.
// The built-in installers come from "loadout" (`loadout installer list` lists
// them all).
import { program, withApt, withBrew, withDnf, withPacman } from "loadout";

export const ripgrep = program("ripgrep", {
  description: "fast grep",
  canBeInstalled: [withDnf, withApt, withPacman, withBrew],
});
