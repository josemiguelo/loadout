package loadout.core

import loadout.core.manifest.Glob
import okio.Path.Companion.toPath
import okio.fakefilesystem.FakeFileSystem
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class GlobTest {
    @Test
    fun matchingFollowsTheSourceRules() {
        assertTrue(Glob.matches("programs/**/*.loadout.kt", "programs/a.loadout.kt"))
        assertTrue(Glob.matches("programs/**/*.loadout.kt", "programs/x/y/a.loadout.kt"))
        assertTrue(!Glob.matches("programs/**/*.loadout.kt", "programs/a.loadout.kt.sample"))
        assertTrue(!Glob.matches("programs/*.kt", "programs/x/a.kt"))
        assertTrue(Glob.matches("programs/?.kt", "programs/a.kt"))
        // Wildcards never match a dot entry; spelling the dot does.
        assertTrue(!Glob.matches("programs/*.kt", "programs/.hidden.kt"))
        assertTrue(!Glob.matches("configs/**/*.loadout.kt", "configs/tmux/.loadout.kt"))
        assertTrue(Glob.matches("configs/**/.loadout.kt", "configs/private_dot_config/tmux/.loadout.kt"))
        assertTrue(!Glob.matches("**/*.kt", ".git/x.kt"))
    }

    @Test
    fun expandIsPathSortedAndNeverEntersGit() {
        val fs = FakeFileSystem()
        val root = "/repo".toPath()
        for (file in listOf("programs/b.loadout.kt", "programs/a/z.loadout.kt", "programs/a.loadout.kt", ".git/c.loadout.kt")) {
            (root / file).parent?.let(fs::createDirectories)
            fs.write(root / file) { writeUtf8("") }
        }
        assertEquals(
            listOf("programs/a.loadout.kt", "programs/a/z.loadout.kt", "programs/b.loadout.kt"),
            Glob.expand(fs, root, "programs/**/*.loadout.kt").map { Glob.relative(root, it) },
        )
        // A literal path is that file or nothing; a missing base is nothing.
        assertEquals(1, Glob.expand(fs, root, "programs/a.loadout.kt").size)
        assertTrue(Glob.expand(fs, root, "nowhere/**/*.kt").isEmpty())
    }

    @Test
    fun problemsNameWhatsWrong() {
        assertNull(Glob.problem("programs/**/*.kt"))
        assertEquals("is absolute; layout paths are relative to the repo root", Glob.problem("/etc"))
        assertEquals("leaves the repo (..)", Glob.problem("../x"))
        assertEquals("has an empty path segment", Glob.problem("a//b"))
        assertEquals("is empty", Glob.problem(""))
    }

    @Test
    fun versionComparisonIsNumericNotLexicographic() {
        assertTrue(versionAtLeast("0.10.0", "0.9.0"))
        assertTrue(versionAtLeast("1.0", "0.99.99"))
        assertTrue(versionAtLeast("0.2.0", "0.2"))
        assertTrue(!versionAtLeast("0.2.0", "0.2.1"))
        assertTrue(versionAtLeast("0.2.0", "0.2.0"))
    }
}
