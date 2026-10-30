# This repo's machines: by hostname, extending {{.ParentName}}'s profiles.

machine "{{.Hostname}}" {
  # extends = [profile.<a profile of {{.ParentName}}>]
}
