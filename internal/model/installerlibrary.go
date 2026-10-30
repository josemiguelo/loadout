package model

// The installers loadout ships with. Mechanics
// belong to the tool, intent belongs to the repo: a config repo says
// "1password, via dnf" and loadout knows what dnf means.
//
// Merged UNDER a repo's own installers when the manifest is assembled — a
// repo installer of the same name replaces the built-in outright — and never
// *detected*: nothing here probes the machine or picks an installer for you,
// mapping still decides everything.
//
// `upgrade` upgrades EVERYTHING the mechanism manages — loadout has no
// per-package form, because partial upgrades are unsupported on Arch and
// discouraged on Fedora, and a package manager resolves its own transaction
// regardless. Converge never runs it; `loadout upgrade` is the explicit verb.
//
// `outdated-all` asks the remote ONCE for everything ("<pkg> <candidate>"
// lines) — that is the only oracle these need. A batch oracle always wins
// over the per-package `outdated` pattern (Manifest.ResolveInstall), so
// spelling one out here would be dead config.

const (
	libraryVersion = `([0-9]+\.[0-9][0-9.]*)`

	dnfOutdated = `dnf -q --cacheonly check-update | awk 'NF>=3 && $2 ~ /^[0-9]/ {name=$1; sub(/[.][^.]*$/, "", name); print name, $2}'`

	brewAwk = `awk '{n=$1; sub(/.*[/]/, "", n); v=$NF; gsub(/[()]/, "", v); print n, v}'`

	pacmanOutdated = `checkupdates --nocolor | awk '$3 == "->" {print $1, $4}'`
)

// InstallerLibrary is the shipped installers, in their documented order (a
// fresh map on every call).
func InstallerLibrary() Map[Installer] {
	s := Ptr[string]
	return MapOf(
		// --- exercised on the maintainer's fleet -------------------------
		E("dnf", Installer{
			Probe:       s("dnf"),
			Install:     s("sudo dnf install -y {pkg}"),
			Upgrade:     s("sudo dnf upgrade --refresh -y"),
			Check:       s("rpm -q {pkg}"),
			OutdatedAll: s(dnfOutdated),
			Regex:       s(libraryVersion),
		}),
		// HOMEBREW_NO_ASK: Homebrew asks before an install that pulls in
		// dependencies; a converge runs unattended.
		E("brew", Installer{
			Probe:       s("brew"),
			Install:     s("HOMEBREW_NO_ASK=1 brew install {pkg}"),
			Upgrade:     s("brew upgrade"),
			Check:       s("brew list --versions {pkg}"),
			OutdatedAll: s("HOMEBREW_NO_AUTO_UPDATE=1 brew outdated --verbose | " + brewAwk),
			Regex:       s(libraryVersion),
		}),
		E("brew-cask", Installer{
			Probe:       s("brew"),
			Install:     s("HOMEBREW_NO_ASK=1 brew install --cask {pkg}"),
			Upgrade:     s("brew upgrade --cask"),
			Check:       s("brew list --cask --versions {pkg}"),
			OutdatedAll: s("HOMEBREW_NO_AUTO_UPDATE=1 brew outdated --cask --verbose | " + brewAwk),
			Regex:       s(libraryVersion),
		}),
		// Flatpak apps at user level; pkg is the application id. The batch
		// line says "Version:" so the shared regex (shaped for remote-info)
		// matches it too.
		E("flatpak", Installer{
			Probe:   s("flatpak"),
			Install: s("flatpak --user install -y flathub {pkg}"),
			Upgrade: s("flatpak --user update -y"),
			Check:   s("flatpak --user info {pkg}"),
			OutdatedAll: s("flatpak --user remote-ls --updates --cached --columns=application,version flathub | " +
				`awk '{print $1, "Version:", $2}'`),
			Regex: s("Version: ([0-9][0-9.]*)"),
		}),
		// A vendor rpm repository: `repofile` is its .repo file — a URL the
		// vendor publishes, or a path in your config repo. dnf imports the key
		// the file names at install time. dnf5 only (`config-manager
		// addrepo`); on dnf4 declare your own installer.
		E("dnf-repo", Installer{
			Probe:       s("dnf"),
			Params:      []string{"repofile"},
			Install:     s("sudo dnf config-manager addrepo --overwrite --from-repofile={repofile} && sudo dnf install -y {pkg}"),
			Upgrade:     s("sudo dnf upgrade --refresh -y"),
			Check:       s("rpm -q {pkg}"),
			OutdatedAll: s(dnfOutdated),
			Regex:       s(libraryVersion),
		}),
		// A COPR is dnf plus one enable step; `copr` names it (params).
		E("dnf-copr", Installer{
			Probe:       s("dnf"),
			Params:      []string{"copr"},
			Install:     s("sudo dnf copr enable -y {copr} && sudo dnf install -y {pkg}"),
			Upgrade:     s("sudo dnf upgrade --refresh -y"),
			Check:       s("rpm -q {pkg}"),
			OutdatedAll: s(dnfOutdated),
			Regex:       s(libraryVersion),
		}),
		// Arch repo packages. The oracle is `checkupdates` (pacman-contrib),
		// not `pacman -Qu`: nothing on Arch refreshes the sync databases
		// between upgrades, so -Qu answers from whenever the last -Syu ran,
		// while checkupdates syncs a private copy without root. Its lines read
		// "<pkg> <installed> -> <candidate>". Without pacman-contrib installed
		// the oracle finds nothing — map pacman-contrib itself so status
		// catches that.
		E("pacman", Installer{
			Probe:       s("pacman"),
			Install:     s("sudo pacman -S --noconfirm {pkg}"),
			Upgrade:     s("sudo pacman -Syu --noconfirm"),
			Check:       s("pacman -Q {pkg}"),
			OutdatedAll: s(pacmanOutdated),
			Regex:       s(libraryVersion),
		}),
		// Arch packages the Omarchy way: `omarchy pkg add` (pacman -S
		// --needed, then its own pacman -Q verification) instead of a bare
		// pacman install. The upgrade is `omarchy update -y`, not pacman -Syu:
		// Omarchy's alpm hook refuses direct system upgrades, and the update
		// also runs Omarchy's migrations (-y skips the opening confirmation;
		// sudo and its other questions still ask, on the terminal). The oracle
		// is pacman's: the databases checkupdates syncs track Omarchy's pinned
		// mirror snapshot, exactly what `omarchy update` brings. Both commands
		// run sudo from inside.
		E("omarchy", Installer{
			Probe:       s("omarchy"),
			Sudo:        true,
			Install:     s("omarchy pkg add {pkg}"),
			Upgrade:     s("omarchy update -y"),
			Check:       s("pacman -Q {pkg}"),
			OutdatedAll: s(pacmanOutdated),
			Regex:       s(libraryVersion),
		}),
		// AUR packages the Omarchy way: `omarchy pkg aur add` (yay, then
		// pacman -Q). The AUR is community build recipes, not Omarchy's repo:
		// map a program here only after deciding to trust it. The upgrade is
		// the same `omarchy update -y` (it upgrades AUR packages too), so
		// `loadout upgrade` runs it once for both. The oracle is yay's AUR
		// check, "<pkg> <installed> -> <candidate>". yay runs sudo from inside.
		E("omarchy-aur", Installer{
			Probe:       s("omarchy"),
			Sudo:        true,
			Install:     s("omarchy pkg aur add {pkg}"),
			Upgrade:     s("omarchy update -y"),
			Check:       s("pacman -Q {pkg}"),
			OutdatedAll: s(`yay -Qua 2>/dev/null | awk '$3 == "->" {print $1, $4}'`),
			Regex:       s(libraryVersion),
		}),
		// --- best effort: install/check only, no update oracle -----------
		// Not exercised by the maintainer; `loadout outdated` reports "no
		// oracle" for programs mapped here. Override in your repo to add one.
		E("apt", Installer{
			Probe:   s("apt-get"),
			Install: s("sudo apt-get install -y {pkg}"),
			Upgrade: s("sudo apt-get upgrade -y"),
			Check:   s("dpkg-query -W {pkg}"),
			Regex:   s(libraryVersion),
		}),
	)
}

// InstallerLibraryNames is the shipped installers' names, in order.
func InstallerLibraryNames() []string { return InstallerLibrary().Keys() }
