package io.github.josemiguelo.postinstaller.core

import io.github.josemiguelo.postinstaller.core.engine.VersionChecker
import io.github.josemiguelo.postinstaller.core.manifest.ManifestLoader
import io.github.josemiguelo.postinstaller.core.model.Program
import io.github.josemiguelo.postinstaller.core.model.ProgramStatus
import io.github.josemiguelo.postinstaller.core.model.VersionCheck
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.coroutines.test.runTest

class VersionCheckerTest {
    private val ripgrep = Program(
        version = VersionCheck("rg --version", "ripgrep ([0-9][0-9a-zA-Z.-]*)"),
    )

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
        val state = VersionChecker(FakeProcessRunner()).check(ripgrep)
        assertEquals(ProgramStatus.MISSING, state.status)
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
        val state = VersionChecker(FakeProcessRunner()).check(Program())
        assertEquals(ProgramStatus.UNKNOWN, state.status)
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

        val results = VersionChecker(runner).checkAll(manifest.programs)
        assertEquals(ProgramStatus.INSTALLED, results.getValue("git").status)
        assertEquals("2.46.0", results.getValue("git").version)
        assertEquals(ProgramStatus.INSTALLED, results.getValue("ripgrep").status)
        assertEquals(ProgramStatus.MISSING, results.getValue("rustup").status)
    }
}
