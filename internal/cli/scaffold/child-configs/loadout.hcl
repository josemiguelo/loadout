# A child repo of {{.ParentName}}: its machines use {{.ParentName}}'s programs, scripts,
# profiles and data by name, and add their own. Nothing here goes into
# {{.ParentName}}; its data schema is {{.ParentName}}'s.
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

  # The repo this one builds on: its programs, scripts, installers, profiles
  # and data schema, by name.
  parent {
    name = "{{.ParentName}}"
    path = "{{.ParentPath}}"
  }
}
