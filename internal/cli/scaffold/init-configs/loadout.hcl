# The repo: its name, where loadout writes each machine's state, chezmoi's
# source (loadouts/), and the manifest files it compiles besides this one.
# Only files these globs match are compiled (* = within a folder, ** = any
# depth; dot-files match only when the glob spells the dot). A tool's file
# sits where its files land in your home, beside its dotfiles, or as a dot
# entry chezmoi never deploys; what lands outside your home and belongs to
# no tool is a folder per concern in loadouts/.etc/ (.etc/dnf/, .etc/t2/).
# `**` never enters a dot folder, so a manifest in one has its own glob,
# and .etc/ one that names it.
repo {
  name    = "my machines"
  state   = "machines/state"
  configs = "loadouts"
  sources = [
    "loadouts/**/.*.loadout.hcl",
    "loadouts/**/.*/.*.loadout.hcl",
    "loadouts/.etc/*/.*.loadout.hcl",
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
