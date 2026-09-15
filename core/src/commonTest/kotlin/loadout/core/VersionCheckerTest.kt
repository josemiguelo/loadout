package loadout.core

import loadout.core.engine.VersionChecker
import loadout.core.manifest.ManifestLoader
import loadout.core.model.ProgramStatus
import loadout.core.model.VersionCheck
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.assertNull
import kotlinx.coroutines.test.runTest

class VersionCheckerTest {
    private val ripgrep = VersionCheck("rg --version", "ripgrep ([0-9][0-9a-zA-Z.-]*)")

    @Test
    fun installedWithVersion() {
        val runner = FakeProcessRunner()
        runner.onCommand("rg --version", stdout = "ripgrep 14.1.0\nfeatures: -simd128\n")
        val state = VersionChecker(runner).check(ripgrep)
        assertEquals(ProgramStatus.INSTALLED, state.status)
        assertEquals("14.1.0", state.version)
    }

    @Test
    fun missingWhenCommandFails() {
        // The check IS the program (no probe): command not found = not installed.
        val state = VersionChecker(FakeProcessRunner()).check(ripgrep)
        assertEquals(ProgramStatus.MISSING, state.status)
    }

    @Test
    fun aCheckThroughAToolThatIsNotThereIsUnknownNotMissing() {
        // brew off PATH once reported every brew program missing. The check
        // asks THROUGH brew (probe set), so a 127 is brew's absence, not bat's.
        val viaBrew = VersionCheck("brew list --versions bat", "([0-9.]+)", probe = "brew")
        val gone = VersionChecker(FakeProcessRunner()).check(viaBrew)
        assertEquals(ProgramStatus.UNKNOWN, gone.status)
        assertEquals("sh: command not found", gone.reason)

        // brew present and saying no is a real missing, with what it said.
        val runner = FakeProcessRunner()
        runner.onCommand("brew list --versions bat", exitCode = 1, stderr = "Error: No such keg: bat")
        val missing = VersionChecker(runner).check(viaBrew)
        assertEquals(ProgramStatus.MISSING, missing.status)
        assertEquals("Error: No such keg: bat", missing.reason)
    }

    @Test
    fun resolvedChecksCarryTheirInstallersProbe() {
        val manifest = ManifestLoader.parse(
            """
            [installers.pm]
            probe = "pm"
            install = "pm install {pkg}"
            check = "pm query {pkg}"
            regex = "([0-9.]+)"

            [programs.bat]
            via = ["pm"]

            [programs.rg]
            [programs.rg.version]
            command = "rg --version"
            regex = "([0-9.]+)"
            [programs.rg.install.pm]
            check = "rg --version"
            """.trimIndent(),
        )
        // A check through the mechanism knows the tool it asks through...
        assertEquals("pm", manifest.checkFor("bat", "pm")!!.probe)
        // ...even when the variant overrides the command: it's still asked
        // through the mechanism the variant is keyed by.
        assertEquals("pm", manifest.checkFor("rg", "pm")!!.probe)
        // The program's own [version] carries none: it IS the program.
        assertNull(manifest.checkFor("rg", null)!!.probe)
    }

    @Test
    fun installedWithoutVersionWhenRegexDoesNotMatch() {
        val runner = FakeProcessRunner()
        runner.onCommand("rg --version", stdout = "something unexpected")
        val state = VersionChecker(runner).check(ripgrep)
        assertEquals(ProgramStatus.INSTALLED, state.status)
        assertNull(state.version)
    }

    @Test
    fun unknownWhenNoVersionCheckDeclared() {
        val state = VersionChecker(FakeProcessRunner()).check(null)
        assertEquals(ProgramStatus.UNKNOWN, state.status)
    }

    @Test
    fun fileCheckCommandsRunAsRepoScripts() {
        val runner = FakeProcessRunner()
        runner.onCommand("sh 'scripts/ver.sh' check", stdout = "tool 2.0")
        val state = VersionChecker(runner).check(VersionCheck("file:scripts/ver.sh check", "tool ([0-9.]+)"))
        assertEquals("2.0", state.version)
    }

    @Test
    fun readsVersionFromStderrWhenStdoutEmpty() {
        val runner = FakeProcessRunner()
        runner.onCommand("rg --version", stderr = "ripgrep 13.0.0")
        val state = VersionChecker(runner).check(ripgrep)
        assertEquals("13.0.0", state.version)
    }

    @Test
    fun checkAllChecksEveryProgram() = runTest {
        val manifest = ManifestLoader.parse(EXAMPLE_MANIFEST)
        val runner = FakeProcessRunner()
        runner.onCommand("git --version", stdout = "git version 2.46.0")
        runner.onCommand("rg --version", stdout = "ripgrep 14.1.0")
        // rustup unregistered -> exit 127 -> MISSING

        val results = VersionChecker(runner).checkAll(manifest.programs.mapValues { it.value.version })
        assertEquals(ProgramStatus.INSTALLED, results.getValue("git").status)
        assertEquals("2.46.0", results.getValue("git").version)
        assertEquals(ProgramStatus.INSTALLED, results.getValue("ripgrep").status)
        assertEquals(ProgramStatus.MISSING, results.getValue("rustup").status)
    }
}
