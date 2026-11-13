// ripgrep, where its files would land (~/.config): a dot file chezmoi
// never deploys. One with scripts gets a dot folder (.ripgrep/, its scripts
// in .loadout/); one with dotfiles sits beside them
// (ripgrep/.ripgrep.loadout.ts). A program says which installers can
// install it; a machine picks one. `loadout explain ripgrep` shows what it
// resolves to. Paths a file names (scripts, `runScript()` commands) are
// relative to its folder.
import { apt, brew, dnf, pacman, program } from "loadout";

export const ripgrep = program("ripgrep", {
  description: "fast grep",
  install: [dnf, apt, pacman, brew],
});
