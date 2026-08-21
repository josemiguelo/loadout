package loadout.core

import loadout.core.engine.UpdateChecker
import loadout.core.manifest.ManifestException
import loadout.core.manifest.ManifestLoader
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
        val manifest = ManifestLoader.parse(
            """
            [installers.dnf]
            install = "sudo dnf install -y {pkg}"
            check = "rpm -q {pkg}"
            outdated = "dnf -q check-update {pkg}"
            regex = "([0-9.]+)"

            [programs.zlib-devel.install.dnf]
            pkg = "zlib-ng"
            """.trimIndent(),
        )
        val resolved = manifest.resolveInstall("zlib-devel", "dnf")
        assertEquals("dnf -q check-update zlib-ng", resolved.outdated?.command)
        assertEquals("([0-9.]+)", resolved.outdated?.regex)

        // No oracle declared -> null.
        val bare = ManifestLoader.parse(
            """
            [programs.x.install.manual]
            command = "true"
            """.trimIndent(),
        )
        assertNull(bare.resolveInstall("x", "manual").outdated)
    }

    @Test
    fun outdatedWithoutRegexIsRejected() {
        val e = assertFailsWith<ManifestException> {
            ManifestLoader.parse(
                """
                [installers.bad]
                install = "install {pkg}"
                outdated = "query {pkg}"
                """.trimIndent(),
            )
        }
        assertTrue("outdated command but no regex" in e.message.orEmpty())
    }
}
