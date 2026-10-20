package loadout.core

import loadout.core.engine.SourceRow
import loadout.core.engine.UpdateChecker
import loadout.core.manifest.ManifestException
import loadout.core.manifest.ManifestAssembler
import loadout.core.manifest.ManifestDraft
import loadout.core.model.Installer
import loadout.core.model.Manifest
import loadout.core.model.OutdatedSource
import loadout.core.model.RepoLayout
import loadout.dsl.manifestOf
import loadout.dsl.invoke
import loadout.dsl.root
import loadout.core.model.VersionCheck
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class UpdateCheckerTest {
    @Test
    fun candidateParsedEvenOnNonZeroExit() {
        // dnf check-update prints the update line and exits 100.
        val runner = FakeProcessRunner()
        runner.onCommand("dnf -q check-update ripgrep", stdout = "ripgrep.x86_64  15.2.0-1.fc44  updates", exitCode = 100)
        val candidate = UpdateChecker(runner).candidate(
            VersionCheck("dnf -q check-update ripgrep", "([0-9]+\\.[0-9][0-9.]*)"),
        )
        assertEquals("15.2.0", candidate)
    }

    @Test
    fun noOutputMeansUpToDate() {
        val runner = FakeProcessRunner()
        runner.onCommand("brew outdated --verbose ripgrep")
        assertNull(UpdateChecker(runner).candidate(VersionCheck("brew outdated --verbose ripgrep", "([0-9.]+)")))
    }

    @Test
    fun outdatedResolvesThroughInstallerWithPkgSubstitution() {
        val manifest = manifestOf {
            val dnf = root.installer("dnf") {
                install = "sudo dnf install -y {pkg}"
                check = "rpm -q {pkg}"
                outdated = "dnf -q check-update {pkg}"
                regex = "([0-9.]+)"
            }
            root.program("zlib-devel") { installVia(dnf("zlib-ng")) }
        }
        val resolved = manifest.resolveInstall("zlib-devel", "dnf")
        assertEquals("dnf -q check-update zlib-ng", resolved.outdated?.command)
        assertEquals("([0-9.]+)", resolved.outdated?.regex)

        // No oracle declared -> null.
        val bare = manifestOf {
            root.program("x") { custom("manual") { command = "true" } }
        }
        assertNull(bare.resolveInstall("x", "manual").outdated)
    }

    @Test
    fun batchCandidatesParsePkgAndCandidateText() {
        val runner = FakeProcessRunner()
        runner.onCommand(
            "list-outdated",
            stdout = "kitty 0.48.2-1.fc44\nobsidian Version: 1.13.7\n\nmalformed\n",
            exitCode = 100,
        )
        val batch = UpdateChecker(runner).batchCandidates("list-outdated")
        assertEquals("0.48.2-1.fc44", batch["kitty"])
        assertEquals("Version: 1.13.7", batch["obsidian"])
        assertEquals(2, batch.size)
    }

    @Test
    fun outdatedAllResolvesPerInstallerAndVariantOverrideWins() {
        val manifest = manifestOf {
            val dnf = root.installer("dnf") {
                install = "sudo dnf install -y {pkg}"
                check = "rpm -q {pkg}"
                outdated = "dnf -q check-update {pkg}"
                outdatedAll = "dnf -q check-update"
                regex = "([0-9.]+)"
            }
            root.program("kitty") { installVia(dnf("kitty-terminal")) }
            root.program("special") { installVia(dnf { outdated = "custom-oracle" }) }
        }
        // Batch oracle covers the plain variant; per-pkg pattern is not used.
        val batched = manifest.resolveInstall("kitty", "dnf")
        assertNull(batched.outdated)
        assertEquals("dnf", batched.outdatedAll?.installer)
        assertEquals("dnf -q check-update", batched.outdatedAll?.command)
        assertEquals("kitty-terminal", batched.outdatedAll?.pkg)
        assertEquals("([0-9.]+)", batched.outdatedAll?.regex)

        // An explicit variant oracle overrides the batch.
        val explicit = manifest.resolveInstall("special", "dnf")
        assertNull(explicit.outdatedAll)
        assertEquals("custom-oracle", explicit.outdated?.command)
    }

    @Test
    fun customSourceRowsParseAndValidate() {
        val runner = FakeProcessRunner()
        runner.onCommand(
            "plugin-sweep",
            stdout = "java 9bd89aa ea1fe99\nruby fa85ede 498c76f extra\n" +
                "go 1111111 2222222 3 commit(s) behind https://github.com/x/go/compare/1111111...2222222\nmalformed line\n",
        )
        val result = UpdateChecker(runner).sourceRows("plugin-sweep")
        assertNull(result.error)
        val rows = result.rows
        assertEquals(3, rows.size)
        assertEquals(SourceRow("java", "9bd89aa", "ea1fe99"), rows[0])
        assertEquals(SourceRow("ruby", "fa85ede", "498c76f", "extra"), rows[1])
        // A URL in the tail is the row's link, lifted out of the note.
        assertEquals(
            SourceRow("go", "1111111", "2222222", "3 commit(s) behind", "https://github.com/x/go/compare/1111111...2222222"),
            rows[2],
        )

        val manifest = manifestOf {
            root.outdated("asdf-plugins", command = "sh sweep.sh")
        }
        assertEquals("sh sweep.sh", manifest.outdated.getValue("asdf-plugins").command)

        val e = assertFailsWith<ManifestException> {
            ManifestAssembler.assembleWithoutFiles(
                ManifestDraft(Manifest(layout = RepoLayout(state = "state"), outdated = mapOf("broken" to OutdatedSource()))),
            )
        }
        assertTrue("outdated.broken needs a command" in e.message.orEmpty())
    }

    @Test
    fun customSourceNonZeroExitIsReportedAsErrorNotEmptyRows() {
        // A crashed/failing source must NOT look like "nothing outdated": its
        // exit code and last stderr line become a surfaced error, no rows.
        val runner = FakeProcessRunner()
        runner.onCommand(
            "flaky-oracle",
            exitCode = 1,
            stdout = "java 9bd89aa ea1fe99\n",
            stderr = "warming up\nfatal: could not fetch remote\n",
        )
        val result = UpdateChecker(runner).sourceRows("flaky-oracle")
        assertTrue(result.rows.isEmpty())
        assertEquals("exited 1: fatal: could not fetch remote", result.error)
    }

    @Test
    fun customSourceMissingBinaryIsReportedAsError() {
        // Unregistered command = exit 127 (missing binary) -> loud error.
        val result = UpdateChecker(FakeProcessRunner()).sourceRows("no-such-oracle")
        assertTrue(result.rows.isEmpty())
        assertTrue(result.error.orEmpty().startsWith("exited 127"))
    }

    // The DSL always gives an installer a regex; a lock written otherwise is still refused.
    private fun installerOnly(installer: Installer) = ManifestAssembler.assembleWithoutFiles(
        ManifestDraft(Manifest(layout = RepoLayout(state = "state"), installers = mapOf("bad" to installer))),
    )

    @Test
    fun outdatedAllWithoutRegexIsRejected() {
        val e = assertFailsWith<ManifestException> {
            installerOnly(Installer(install = "install {pkg}", outdatedAll = "query"))
        }
        assertTrue("outdated-all command but no regex" in e.message.orEmpty())
    }

    @Test
    fun outdatedWithoutRegexIsRejected() {
        val e = assertFailsWith<ManifestException> {
            installerOnly(Installer(install = "install {pkg}", outdated = "query {pkg}"))
        }
        assertTrue("outdated command but no regex" in e.message.orEmpty())
    }

    @Test
    fun aProgramsPathComesFirstForItsOutdatedCheck() {
        val runner = FakeProcessRunner()
        runner.onCommand("PATH=\"/opt/x:\$PATH\"; export PATH; x latest", stdout = "2.0.0")
        val check = VersionCheck("x latest", "([0-9.]+)", path = listOf("/opt/x"))
        assertEquals("2.0.0", UpdateChecker(runner).candidate(check))
    }
}
