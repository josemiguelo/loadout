# CI and release

`.github/workflows/ci.yml`: ubuntu (`go vet` + unit tests, the binary,
integration, a cross-build of every release target) and macos (`go vet` +
unit tests, a release-flagged binary — CGO off, `-trimpath -ldflags='-s
-w'` —, integration against it). It runs on pushes to `master` and on pull
requests; the Go version comes from go.mod.
Runners differ from a desktop: Ubuntu's `/bin/sh` is dash ("not found", not
bash's "command not found"), and `TERM` is unset (Linux) or unusable
(macOS), so `pty_run` sets its own.
Reproduce the Linux job locally in an `ubuntu:24.04` container as a non-root user.
The integration suite compiles TypeScript repos: `run-tests.sh` uses `bun` from PATH as `LOADOUT_BUN` when there is one, else loadout downloads its `bun.DefaultVersion` on the first compile (network on the runners).
`release.yml` on `v*` tags: one ubuntu runner cross-compiles each target
(`CGO_ENABLED=0`, `-trimpath -ldflags='-s -w'`) and tars the binary alone
→ `loadout-<tag>-{linux-x64,linux-arm64,macos-arm64,macos-x64}.tar.gz`
attached to the GitHub Release. Nothing runs the linux-arm64 or macos-x64
binaries before release. It packages without testing: let CI pass before
tagging. **The version lives in ONE place**, `internal/version/version.go`'s
`var Version = "…"` (the binary's `--version`, the lock's `toolVersion`);
release.yml's first job refuses a tag that isn't `v<Version>`. A release =
bump that line, commit, tag.

`install.sh` (repo root) is the curl|sh bootstrap over those releases: it
resolves latest via the GitHub API (pin: LOADOUT_VERSION) and installs the
one binary to ~/.local/bin (LOADOUT_INSTALL_DIR); keep its target names in
sync with release.yml. An older loadout's `~/.local/share/loadout` (its
Kotlin DSL and Gradle plugin) is left as it was: install.sh never deletes
what it no longer installs. It reads the installed version BEFORE
overwriting, so an upgrade (including `loadout self-upgrade`, which shells
out to it) says "was vX" and skips the first-install "Next steps".
Testable offline via LOADOUT_DOWNLOAD_BASE=file://… against a local
tarball; run-tests.sh covers both paths on both platforms, staging one
stub tarball per release name so `install.sh` resolves the host's own
target (don't repeat that mapping in the test: a Rosetta shell says x86_64
where macos-arm64 is still right).
