package loadout.core.manifest

import loadout.core.model.Installer

/**
 * The installers loadout ships with. Mechanics belong to the tool, intent
 * belongs to the repo: a config repo says "1password, via dnf" and loadout
 * knows what dnf means.
 *
 * These are merged UNDER a repo's own `[installers.*]` at load
 * ([ManifestLoader.loadRepo]) — a repo definition of the same name replaces
 * the built-in outright — and they are never *detected*: nothing here probes the
 * machine or picks an installer for you, mapping still decides everything.
 *
 * Kept as TOML text, not as constructed objects, so `installers --eject`
 * hands you the exact thing loadout uses and `installers <name>` can show
 * it verbatim.
 */
object InstallerLibrary {
    val TOML: String = """
# Installers that ship with loadout: each mechanism's probe, install
# command, version check and update oracles, defined once. {pkg} is the
# package id — it defaults to the program name.
#
# A repo does not need this file: these are built in, and `via = ["dnf"]`
# resolves to the definition below. Declaring [installers.<name>] in your
# own manifest replaces the built-in of that name outright.
# `loadout installers --eject` writes this file into your repo when you
# want to pin or patch it.
#
# `upgrade` upgrades EVERYTHING the mechanism manages — loadout has no
# per-package form, because partial upgrades are unsupported on Arch and
# discouraged on Fedora, and a package manager resolves its own transaction
# regardless. Converge never runs it; `loadout upgrade` is the explicit verb.
#
# `outdated-all` asks the remote ONCE for everything ("<pkg> <candidate>"
# lines) — that is the only oracle these need. The per-pkg `outdated` key
# still exists for repos to use, but a batch oracle always wins over it
# (Manifest.resolveInstall), so spelling one out here would be dead config.

# --- exercised on the maintainer's fleet ---------------------------------
[installers.dnf]
probe = "dnf"
install = "sudo dnf install -y {pkg}"
upgrade = "sudo dnf upgrade --refresh -y"
check = "rpm -q {pkg}"
outdated-all = "dnf -q --cacheonly check-update | awk 'NF>=3 && $2 ~ /^[0-9]/ {name=$1; sub(/[.][^.]*$/, \"\", name); print name, $2}'"
regex = "([0-9]+\\.[0-9][0-9.]*)"

[installers.brew]
probe = "brew"
install = "brew install {pkg}"
upgrade = "brew upgrade"
check = "brew list --versions {pkg}"
outdated-all = "HOMEBREW_NO_AUTO_UPDATE=1 brew outdated --verbose | awk '{n=$1; sub(/.*[/]/, \"\", n); v=${'$'}NF; gsub(/[()]/, \"\", v); print n, v}'"
regex = "([0-9]+\\.[0-9][0-9.]*)"

[installers.brew-cask]
probe = "brew"
install = "brew install --cask {pkg}"
upgrade = "brew upgrade --cask"
check = "brew list --cask --versions {pkg}"
outdated-all = "HOMEBREW_NO_AUTO_UPDATE=1 brew outdated --cask --verbose | awk '{n=$1; sub(/.*[/]/, \"\", n); v=${'$'}NF; gsub(/[()]/, \"\", v); print n, v}'"
regex = "([0-9]+\\.[0-9][0-9.]*)"

# Flatpak apps at user level; pkg is the application id. The batch line says
# "Version:" so the shared regex (shaped for remote-info) matches it too.
[installers.flatpak]
probe = "flatpak"
install = "flatpak --user install -y flathub {pkg}"
upgrade = "flatpak --user update -y"
check = "flatpak --user info {pkg}"
outdated-all = "flatpak --user remote-ls --updates --cached --columns=application,version flathub | awk '{print $1, \"Version:\", $2}'"
regex = "Version: ([0-9][0-9.]*)"

# A vendor rpm repository: `repofile` is its .repo file — a URL the vendor
# publishes, or a path in your config repo (commands run with the repo root
# as cwd). dnf imports the key the file names at install time. dnf5 only
# (`config-manager addrepo`); on dnf4 declare your own installer.
[installers.dnf-repo]
probe = "dnf"
params = ["repofile"]
install = "sudo dnf config-manager addrepo --overwrite --from-repofile={repofile} && sudo dnf install -y {pkg}"
upgrade = "sudo dnf upgrade --refresh -y"
check = "rpm -q {pkg}"
outdated-all = "dnf -q --cacheonly check-update | awk 'NF>=3 && ${'$'}2 ~ /^[0-9]/ {name=${'$'}1; sub(/[.][^.]*${'$'}/, \"\", name); print name, ${'$'}2}'"
regex = "([0-9]+\\.[0-9][0-9.]*)"

# A COPR is dnf plus one enable step; `copr` names it (params).
[installers.dnf-copr]
probe = "dnf"
params = ["copr"]
install = "sudo dnf copr enable -y {copr} && sudo dnf install -y {pkg}"
upgrade = "sudo dnf upgrade --refresh -y"
check = "rpm -q {pkg}"
outdated-all = "dnf -q --cacheonly check-update | awk 'NF>=3 && ${'$'}2 ~ /^[0-9]/ {name=${'$'}1; sub(/[.][^.]*${'$'}/, \"\", name); print name, ${'$'}2}'"
regex = "([0-9]+\\.[0-9][0-9.]*)"

# Arch repo packages. The oracle is `checkupdates` (pacman-contrib), not
# `pacman -Qu`: nothing on Arch refreshes the sync databases between
# upgrades, so -Qu answers from whenever the last -Syu ran, while
# checkupdates syncs a private copy without root. Its lines read
# "<pkg> <installed> -> <candidate>". Without pacman-contrib installed the
# oracle finds nothing — map pacman-contrib itself so status catches that.
[installers.pacman]
probe = "pacman"
install = "sudo pacman -S --noconfirm {pkg}"
upgrade = "sudo pacman -Syu --noconfirm"
check = "pacman -Q {pkg}"
outdated-all = "checkupdates --nocolor | awk '$3 == \"->\" {print $1, $4}'"
regex = "([0-9]+\\.[0-9][0-9.]*)"

# --- best effort: install/check only, no update oracle -------------------
# Not exercised by the maintainer; `loadout outdated` reports "no oracle"
# for programs mapped here. Override in your repo to add one.
[installers.apt]
probe = "apt-get"
install = "sudo apt-get install -y {pkg}"
upgrade = "sudo apt-get upgrade -y"
check = "dpkg-query -W {pkg}"
regex = "([0-9]+\\.[0-9][0-9.]*)"
""".trimIndent() + "\n"

    /** Parsed once; the same map every load merges under the repo's own. */
    val installers: Map<String, Installer> by lazy { ManifestLoader.parseInstallers(TOML) }

    val names: Set<String> get() = installers.keys
}
