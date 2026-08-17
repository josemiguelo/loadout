package io.github.josemiguelo.postinstaller.core

import io.github.josemiguelo.postinstaller.core.model.MachineState
import io.github.josemiguelo.postinstaller.core.model.ProgramState
import io.github.josemiguelo.postinstaller.core.model.ProgramStatus
import io.github.josemiguelo.postinstaller.core.state.StateStore
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import okio.Path.Companion.toPath
import okio.fakefilesystem.FakeFileSystem

class StateStoreTest {
    private fun sampleState(machine: String, rgVersion: String?) = MachineState(
        machine = machine,
        os = "linux",
        distro = "fedora",
        arch = "x86_64",
        toolVersion = "0.1.0",
        updatedAt = "2026-08-14T12:00:00Z",
        programs = mapOf(
            "ripgrep" to if (rgVersion != null) {
                ProgramState(ProgramStatus.INSTALLED, rgVersion)
            } else {
                ProgramState(ProgramStatus.MISSING)
            },
        ),
    )

    @Test
    fun roundTripsState() {
        val fs = FakeFileSystem()
        val store = StateStore(fs, "/repo".toPath())

        store.write(sampleState("laptop", "14.1.0"))
        val loaded = store.read("laptop")

        assertEquals(sampleState("laptop", "14.1.0"), loaded)
        assertNull(store.read("ghost"))
    }

    @Test
    fun readAllReturnsAllMachines() {
        val fs = FakeFileSystem()
        val store = StateStore(fs, "/repo".toPath())

        store.write(sampleState("laptop", "14.1.0"))
        store.write(sampleState("desktop", null))

        val all = store.readAll()
        assertEquals(setOf("laptop", "desktop"), all.keys)
        assertEquals(ProgramStatus.MISSING, all.getValue("desktop").programs.getValue("ripgrep").status)
    }

    @Test
    fun readAllOnEmptyRepoIsEmpty() {
        val store = StateStore(FakeFileSystem(), "/repo".toPath())
        assertTrue(store.readAll().isEmpty())
    }

    @Test
    fun writtenJsonUsesLowercaseStatusNames() {
        val fs = FakeFileSystem()
        val store = StateStore(fs, "/repo".toPath())
        store.write(sampleState("laptop", "14.1.0"))

        val text = fs.read("/repo/state/laptop.json".toPath()) { readUtf8() }
        assertTrue("\"installed\"" in text)
        assertTrue("INSTALLED" !in text)
    }
}
