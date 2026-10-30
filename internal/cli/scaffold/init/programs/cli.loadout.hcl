# Programs. A program says which installers can install it; a machine
# picks one.
# `loadout explain ripgrep` shows what it resolves to. Paths a file names
# (scripts, `file:` commands) are relative to its folder.

program "ripgrep" {
  description = "fast grep"
  install_via = [
    dnf,
    apt,
    pacman,
    brew,
  ]
}
