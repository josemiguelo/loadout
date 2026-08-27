package loadout.core

import loadout.core.engine.SourceRow
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
        val manifest = ManifestLoader.parse(
            """
            [installers.dnf]
            install = "sudo dnf install -y {pkg}"
            check = "rpm -q {pkg}"
            outdated = "dnf -q check-update {pkg}"
            outdated-all = "dnf -q check-update"
            regex = "([0-9.]+)"

            [programs.kitty.install.dnf]
            pkg = "kitty-terminal"

            [programs.special.install.dnf]
            outdated = "custom-oracle"
            """.trimIndent(),
        )
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
        runner.onCommand("plugin-sweep", stdout = "java 9bd89aa ea1fe99\nruby fa85ede 498c76f extra\nmalformed line\n")
        val rows = UpdateChecker(runner).sourceRows("plugin-sweep")
        assertEquals(2, rows.size)
        assertEquals(SourceRow("java", "9bd89aa", "ea1fe99"), rows[0])
        assertEquals(SourceRow("ruby", "fa85ede", "498c76f", "extra"), rows[1])

        val manifest = ManifestLoader.parse(
            """
            [outdated.asdf-plugins]
            command = "sh sweep.sh"
            """.trimIndent(),
        )
        assertEquals("sh sweep.sh", manifest.outdated.getValue("asdf-plugins").command)

        val e = assertFailsWith<ManifestException> {
            ManifestLoader.parse(
                """
                [outdated.broken]
                """.trimIndent(),
            )
        }
        assertTrue("outdated.broken needs a command" in e.message.orEmpty())
    }

    @Test
    fun outdatedAllWithoutRegexIsRejected() {
        val e = assertFailsWith<ManifestException> {
            ManifestLoader.parse(
                """
                [installers.bad]
                install = "install {pkg}"
                outdated-all = "query"
                """.trimIndent(),
            )
        }
        assertTrue("outdated-all command but no regex" in e.message.orEmpty())
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
