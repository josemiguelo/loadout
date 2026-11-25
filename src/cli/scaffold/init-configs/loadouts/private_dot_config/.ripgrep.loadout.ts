// ripgrep, where its files would land (~/.config): a dot file chezmoi
// never deploys. One with scripts gets a dot folder (.ripgrep/, its scripts
// in .loadout/); one with dotfiles sits beside them
// (ripgrep/.ripgrep.loadout.ts). A program says which installers can
// install it; a machine picks one. `loadout explain ripgrep` shows what it
// resolves to. Paths a file names (scripts, `runFile()` commands) are
// relative to its folder.
import { program, withApt, withBrew, withDnf, withPacman } from "loadout";

export const ripgrep = program("ripgrep", {
  description: "fast grep",
  canBeInstalled: [withDnf, withApt, withPacman, withBrew],
});
