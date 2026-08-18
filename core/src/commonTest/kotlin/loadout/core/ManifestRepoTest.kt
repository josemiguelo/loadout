package loadout.core

import loadout.core.manifest.ManifestException
import loadout.core.manifest.ManifestLoader
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import okio.Path.Companion.toPath
import okio.fakefilesystem.FakeFileSystem

/** Tests for split-repo loading: manifest.d/ fragments and machines/ config files. */
class ManifestRepoTest {
    private val repo = "/repo".toPath()

    private fun fs(files: Map<String, String>): FakeFileSystem {
        val fs = FakeFileSystem()
        for ((path, content) in files) {
            val full = repo / path
            full.parent?.let { fs.createDirectories(it) }
            fs.write(full) { writeUtf8(content) }
        }
        return fs
    }

    @Test
    fun mergesFragmentsAndMachineFiles() {
        val fs = fs(
            mapOf(
                "manifest.toml" to """
                    [meta]
                    name = "split repo"

                    [programs.git]
                    [programs.git.install]
                    dnf = "sudo dnf install -y git"
                """.trimIndent(),
                "manifest.d/cli.toml" to """
                    [programs.ripgrep]
                    depends-on = ["git"]
                    [programs.ripgrep.install]
                    dnf = "sudo dnf install -y ripgrep"

                    [scripts.marker]
                    run = "true"
                """.trimIndent(),
                "machines/laptop.toml" to """
                    [pm]
                    git = "dnf"
                    ripgrep = "dnf"
                """.trimIndent(),
            ),
        )

        val manifest = ManifestLoader.loadRepo(fs, repo)
        assertEquals("split repo", manifest.meta.name)
        assertEquals(setOf("git", "ripgrep"), manifest.programs.keys)
        assertEquals(setOf("marker"), manifest.scripts.keys)
        // Machine file name (minus .toml) becomes the machine name; cross-file refs validate.
        assertEquals("dnf", manifest.machines.getValue("laptop").pm["ripgrep"])
    }

    @Test
    fun duplicateProgramAcrossFragmentsFails() {
        val fs = fs(
            mapOf(
                "manifest.toml" to "[programs.git]\n[programs.git.install]\ndnf = \"x\"",
                "manifest.d/extra.toml" to "[programs.git]\n[programs.git.install]\napt = \"y\"",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("duplicate program 'git'" in e.message.orEmpty())
        assertTrue("manifest.d/extra.toml" in e.message.orEmpty())
    }

    @Test
    fun inlineMachinesInRootManifestFails() {
        val fs = fs(
            mapOf(
                "manifest.toml" to """
                    [programs.git]
                    [programs.git.install]
                    dnf = "x"

                    [machines.laptop.pm]
                    git = "dnf"
                """.trimIndent(),
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("[machines.*] sections are not allowed" in e.message.orEmpty())
    }

    @Test
    fun inlineMachinesInFragmentFails() {
        val fs = fs(
            mapOf(
                "manifest.toml" to "[programs.git]\n[programs.git.install]\ndnf = \"x\"",
                "manifest.d/extra.toml" to "[machines.laptop.pm]\ngit = \"dnf\"",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("[machines.*] sections are not allowed" in e.message.orEmpty())
        assertTrue("manifest.d/extra.toml" in e.message.orEmpty())
    }

    @Test
    fun metaInFragmentFails() {
        val fs = fs(
            mapOf(
                "manifest.toml" to "[programs.git]\n[programs.git.install]\ndnf = \"x\"",
                "manifest.d/extra.toml" to "[meta]\nname = \"nope\"",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("[meta] is only allowed" in e.message.orEmpty())
    }

    @Test
    fun machineFileMappingIsValidatedAgainstMergedPrograms() {
        val fs = fs(
            mapOf(
                "manifest.toml" to "[programs.git]\n[programs.git.install]\ndnf = \"x\"",
                "machines/laptop.toml" to "[pm]\nghost = \"dnf\"",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("unknown program 'ghost'" in e.message.orEmpty())
    }

    @Test
    fun scriptFileMustExistInRepo() {
        val fs = fs(
            mapOf(
                "manifest.toml" to """
                    [scripts.dotfiles]
                    file = "scripts/dotfiles.sh"
                """.trimIndent(),
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("file 'scripts/dotfiles.sh' not found in the repo" in e.message.orEmpty())

        fs.createDirectories(repo / "scripts")
        fs.write(repo / "scripts" / "dotfiles.sh") { writeUtf8("#!/bin/sh\n") }
        assertEquals("scripts/dotfiles.sh", ManifestLoader.loadRepo(fs, repo).scripts.getValue("dotfiles").file)
    }

    @Test
    fun fileInstallValueMustExistInRepo() {
        val fs = fs(
            mapOf(
                "manifest.toml" to """
                    [programs.tool]
                    [programs.tool.install]
                    script = "file:scripts/install-tool.sh"
                """.trimIndent(),
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue(
            "programs.tool.install.script: file 'scripts/install-tool.sh' not found in the repo" in e.message.orEmpty(),
        )

        fs.createDirectories(repo / "scripts")
        fs.write(repo / "scripts" / "install-tool.sh") { writeUtf8("#!/bin/sh\n") }
        assertEquals(
            "file:scripts/install-tool.sh",
            ManifestLoader.loadRepo(fs, repo).programs.getValue("tool").install["script"],
        )
    }

    @Test
    fun minToolVersionIsEnforced() {
        val fs = fs(
            mapOf(
                "manifest.toml" to """
                    [meta]
                    min-tool-version = "999.0.0"

                    [programs.git]
                    [programs.git.install]
                    dnf = "x"
                """.trimIndent(),
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("requires loadout >= 999.0.0" in e.message.orEmpty())
        assertTrue("upgrade loadout" in e.message.orEmpty())
    }

    @Test
    fun minToolVersionAtOrBelowCurrentLoads() {
        val fs = fs(
            mapOf(
                "manifest.toml" to """
                    [meta]
                    min-tool-version = "0.1.0"

                    [programs.git]
                    [programs.git.install]
                    dnf = "x"
                """.trimIndent(),
            ),
        )
        assertEquals(setOf("git"), ManifestLoader.loadRepo(fs, repo).programs.keys)
    }

    @Test
    fun versionComparisonIsNumericNotLexicographic() {
        assertTrue(ManifestLoader.versionAtLeast("0.10.0", "0.9.0"))
        assertTrue(ManifestLoader.versionAtLeast("1.0", "0.99.99"))
        assertTrue(ManifestLoader.versionAtLeast("0.2.0", "0.2"))
        assertTrue(!ManifestLoader.versionAtLeast("0.2.0", "0.2.1"))
        assertTrue(ManifestLoader.versionAtLeast("0.2.0", "0.2.0"))
    }

    @Test
    fun missingRootManifestFails() {
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(FakeFileSystem(), repo) }
        assertTrue("Manifest not found" in e.message.orEmpty())
    }

    @Test
    fun repoWithoutFragmentOrMachineDirsLoadsFine() {
        val fs = fs(
            mapOf(
                "manifest.toml" to """
                    [programs.git]
                    [programs.git.install]
                    dnf = "x"
                """.trimIndent(),
            ),
        )
        val manifest = ManifestLoader.loadRepo(fs, repo)
        assertEquals(setOf("git"), manifest.programs.keys)
        assertTrue(manifest.machines.isEmpty())
    }
}
