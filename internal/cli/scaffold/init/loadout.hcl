# The repo: its name, where loadout writes each machine's state, and the
# manifest files it compiles besides this one. Only files these globs match
# are compiled (* = within a folder, ** = any depth; dot-files match only
# when the glob spells the dot).
repo {
  name    = "my machines"
  state   = "machines/state"
  sources = [
    "programs/**/*.loadout.hcl",
    "maintenance/**/*.loadout.hcl",
    "machines/**/*.loadout.hcl",
  ]
}

# Every per-machine setting, with its default: the data every machine
# carries (dotfile templates read it too). A machine sets its own with
# `data = { work = true }`.
data {
  # A work machine.
  work = flag(false)
}

# The built-in installers are names as they are: dnf, apt, pacman, brew
# (`loadout installers` lists them all).
