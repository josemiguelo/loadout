package loadout.core

import loadout.core.diff.DiffEngine
import loadout.core.diff.InstallState
import loadout.core.manifest.ManifestLoader
import loadout.core.model.MachineState
import loadout.core.model.ProgramState
import loadout.core.model.ProgramStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DiffEngineTest {
    private val manifest = ManifestLoader.parse(EXAMPLE_MANIFEST)

    private fun state(machine: String, programs: Map<String, ProgramState>) = MachineState(
        machine = machine,
        os = "linux",
        arch = "x86_64",
        toolVersion = "0.1.0",
        updatedAt = "2026-08-14T12:00:00Z",
        programs = programs,
    )

    @Test
    fun detectsDriftMissingAndUnknown() {
        val laptop = state(
            "laptop",
            mapOf(
                "git" to ProgramState(ProgramStatus.INSTALLED, "2.46.0"),
                "ripgrep" to ProgramState(ProgramStatus.INSTALLED, "14.1.0"),
                "rustup" to ProgramState(ProgramStatus.MISSING),
            ),
        )
        val desktop = state(
            "desktop",
            mapOf(
                "git" to ProgramState(ProgramStatus.INSTALLED, "2.43.0"),
                "ripgrep" to ProgramState(ProgramStatus.INSTALLED, "14.1.0"),
                // no rustup entry at all -> Unknown
            ),
        )

        val report = DiffEngine.diff(manifest, listOf(laptop, desktop))

        assertEquals(listOf("desktop", "laptop"), report.machines)
        assertEquals(listOf("git", "ripgrep", "rustup"), report.rows.map { it.program })

        val git = report.rows.first { it.program == "git" }
        assertTrue(git.drift)
        assertFalse(git.incomplete)

        val ripgrep = report.rows.first { it.program == "ripgrep" }
        assertFalse(ripgrep.drift)
        assertFalse(ripgrep.incomplete)

        val rustup = report.rows.first { it.program == "rustup" }
        assertFalse(rustup.drift)
        assertTrue(rustup.incomplete)
        assertEquals(InstallState.Unknown, rustup.perMachine.getValue("desktop"))
        assertEquals(InstallState.Missing, rustup.perMachine.getValue("laptop"))

        assertTrue(report.hasDrift)
        assertTrue(report.hasMissing)
    }

    @Test
    fun cleanReportHasNoFlags() {
        val a = state("a", mapOf(
            "git" to ProgramState(ProgramStatus.INSTALLED, "2.46.0"),
            "ripgrep" to ProgramState(ProgramStatus.INSTALLED, "14.1.0"),
            "rustup" to ProgramState(ProgramStatus.INSTALLED, "1.27.1"),
        ))
        val b = state("b", mapOf(
            "git" to ProgramState(ProgramStatus.INSTALLED, "2.46.0"),
            "ripgrep" to ProgramState(ProgramStatus.INSTALLED, "14.1.0"),
            "rustup" to ProgramState(ProgramStatus.INSTALLED, "1.27.1"),
        ))

        val report = DiffEngine.diff(manifest, listOf(a, b))
        assertFalse(report.hasDrift)
        assertFalse(report.hasMissing)
    }
}
