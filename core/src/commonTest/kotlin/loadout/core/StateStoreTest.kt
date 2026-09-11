package loadout.core

import loadout.core.model.MachineState
import loadout.core.model.ProgramState
import loadout.core.model.ProgramStatus
import loadout.core.state.StateStore
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
    fun newerSchemaStateFilesAreSkippedWithWarning() {
        val fs = FakeFileSystem()
        val store = StateStore(fs, "/repo".toPath())
        store.write(sampleState("laptop", "14.1.0"))
        fs.write("/repo/state/future.json".toPath()) {
            writeUtf8(
                """{"schemaVersion": 99, "machine": "future", "os": "linux", "arch": "x86_64",
                    "toolVersion": "9.9.9", "updatedAt": "2027-01-01T00:00:00Z"}""",
            )
        }

        val all = store.readAll()
        assertEquals(setOf("laptop"), all.keys)
        assertEquals(1, store.lastWarnings.size)
        assertTrue("newer loadout" in store.lastWarnings.single())

        assertNull(store.read("future"))
        assertTrue(store.lastWarnings.isNotEmpty())
        store.read("laptop")
        assertTrue(store.lastWarnings.isEmpty())
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

    @Test
    fun anUnreadableStateFileWarnsInsteadOfCrashing() {
        val fs = FakeFileSystem()
        val repo = "/repo".toPath()
        fs.createDirectories(repo / "state")
        fs.write(repo / "state" / "m1.json") { writeUtf8("{ this is not json") }
        fs.write(repo / "state" / "m2.json") { writeUtf8("{ also broken") }
        val store = StateStore(fs, repo)

        // read(): a crash here reaches the user as a stack trace (contract 9).
        assertNull(store.read("m1"))
        assertEquals(1, store.lastWarnings.size, store.lastWarnings.toString())
        assertTrue("state/m1.json" in store.lastWarnings.single(), store.lastWarnings.single())

        // readAll(): silence here would make the machine vanish from `diff`.
        assertTrue(store.readAll().isEmpty())
        assertEquals(2, store.lastWarnings.size, store.lastWarnings.toString())
    }
}
