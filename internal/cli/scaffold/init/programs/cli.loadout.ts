// Programs. A program says which installers can install it; a machine
// picks one. `loadout explain ripgrep` shows what it resolves to. Paths a
// file names (scripts, `runScript()` commands) are relative to its folder.
// The built-in installers come from "loadout" (`loadout installers` lists
// them all).
import { apt, brew, dnf, pacman, program } from "loadout";

export const ripgrep = program("ripgrep", {
  description: "fast grep",
  install: [dnf, apt, pacman, brew],
});
