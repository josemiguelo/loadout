# Machines, by hostname, and the profiles they share. A machine installs
# only what it (or a profile it extends) names, and runs only the scripts
# it names.

machine "{{.Hostname}}" {
  # Pick how this machine installs ripgrep, then uncomment:
  # via "dnf" {
  #   install = [program.ripgrep]
  # }
}
