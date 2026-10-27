package loadout.dsl

import okio.Path.Companion.toPath
import okio.fakefilesystem.FakeFileSystem
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class CompileTest {
    private val root = "/repo".toPath()
    private val sources = listOf("loadout.kt", "programs/**/*.loadout.kt", "configs/**/.*.loadout.kt")

    private fun fs(vararg files: String) = FakeFileSystem().apply {
        for (file in files) {
            createDirectories((root / file).parent!!)
            write(root / file) { writeUtf8("package repo\n") }
        }
    }

    @Test
    fun eachFileNameMapsToItsFolder() {
        val fs = fs("loadout.kt", "programs/cli.loadout.kt", "configs/kitty/.kitty.loadout.kt")
        assertEquals(
            mapOf("loadout.kt" to "", "cli.loadout.kt" to "programs", ".kitty.loadout.kt" to "configs/kitty"),
            manifestFolders(fs, root, sources),
        )
    }

    @Test
    fun twoFilesOfOneNameAreRefused() {
        val fs = fs("programs/a/apps.loadout.kt", "programs/b/apps.loadout.kt")
        val message = assertFailsWith<DslException> { manifestFolders(fs, root, sources) }.message.orEmpty()
        assertTrue("manifest file names must be unique: apps.loadout.kt in programs/a and programs/b" in message, message)
    }

    private val parentRoot = "/parent".toPath()

    private fun parentArgs() = ParentArgs("dotfiles", "~/dots", parentRoot, emptyList(), listOf("loadout.kt", "programs/**/*.loadout.kt"))

    @Test
    fun aParentsFilesMapToParentFolders() {
        val fs = fs("child.kt", "programs/work.loadout.kt").apply {
            createDirectories(parentRoot / "programs" / "cli")
            write(parentRoot / "loadout.kt") { writeUtf8("package p\n") }
            write(parentRoot / "programs" / "cli" / "cli.loadout.kt") { writeUtf8("package p\n") }
        }
        assertEquals(
            mapOf(
                "child.kt" to "",
                "work.loadout.kt" to "programs",
                "loadout.kt" to "parent:",
                "cli.loadout.kt" to "parent:programs/cli",
            ),
            manifestFolders(fs, root, listOf("child.kt", "programs/**/*.loadout.kt"), parentArgs()),
        )
    }

    @Test
    fun aNameInBothReposIsRefusedNamingBoth() {
        val fs = fs("loadout.kt").apply {
            createDirectories(parentRoot)
            write(parentRoot / "loadout.kt") { writeUtf8("package p\n") }
        }
        val message = assertFailsWith<DslException> { manifestFolders(fs, root, sources, parentArgs()) }.message.orEmpty()
        assertTrue("manifest file names must be unique: loadout.kt in its root (parent dotfiles) and the repo root (this repo)" in message, message)
    }
}
