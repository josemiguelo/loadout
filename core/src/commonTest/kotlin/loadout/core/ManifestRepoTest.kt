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
                    [programs.git.install.dnf]
                    command = "sudo dnf install -y git"
                """.trimIndent(),
                "manifest.d/cli.toml" to """
                    [programs.ripgrep]
                    depends-on = ["git"]
                    [programs.ripgrep.install.dnf]
                    command = "sudo dnf install -y ripgrep"

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
    fun fragmentsInSubfoldersAreMerged() {
        val fs = fs(
            mapOf(
                "manifest.toml" to "[meta]\nname = \"nested\"",
                "manifest.d/dev/editors/kitty.toml" to """
                    [programs.kitty]
                    [programs.kitty.install.dnf]
                    command = "sudo dnf install -y kitty"
                """.trimIndent(),
                "manifest.d/media.toml" to """
                    [programs.vlc]
                    [programs.vlc.install.dnf]
                    command = "sudo dnf install -y vlc"
                """.trimIndent(),
            ),
        )
        val manifest = ManifestLoader.loadRepo(fs, repo)
        assertEquals(setOf("kitty", "vlc"), manifest.programs.keys)
    }

    @Test
    fun duplicateAcrossSubfoldersNamesTheFullPath() {
        val fs = fs(
            mapOf(
                "manifest.toml" to "[meta]\nname = \"nested\"",
                "manifest.d/a/tool.toml" to "[programs.tool]\n[programs.tool.install.dnf]\ncommand = \"x\"",
                "manifest.d/b/tool.toml" to "[programs.tool]\n[programs.tool.install.dnf]\ncommand = \"y\"",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("duplicate program 'tool'" in e.message.orEmpty())
        assertTrue("manifest.d/b/tool.toml" in e.message.orEmpty())
    }

    @Test
    fun duplicateProgramAcrossFragmentsFails() {
        val fs = fs(
            mapOf(
                "manifest.toml" to "[programs.git]\n[programs.git.install.dnf]\ncommand = \"x\"",
                "manifest.d/extra.toml" to "[programs.git]\n[programs.git.install.apt]\ncommand = \"y\"",
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
                    [programs.git.install.dnf]
                    command = "x"

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
                "manifest.toml" to "[programs.git]\n[programs.git.install.dnf]\ncommand = \"x\"",
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
                "manifest.toml" to "[programs.git]\n[programs.git.install.dnf]\ncommand = \"x\"",
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
                "manifest.toml" to "[programs.git]\n[programs.git.install.dnf]\ncommand = \"x\"",
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
                    [programs.tool.install.script]
                    command = "file:scripts/install-tool.sh"
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
            ManifestLoader.loadRepo(fs, repo).resolveInstall("tool", "script").command,
        )
    }

    @Test
    fun fileCheckCommandsMustExistInRepo() {
        val fs = fs(
            mapOf(
                "manifest.toml" to """
                    [programs.tool]
                    [programs.tool.install.script]
                    command = "true"
                    check = "file:scripts/tool-check.sh check"
                    regex = "([0-9.]+)"

                    [scripts.setup]
                    run = "true"
                    check = "file:scripts/setup.sh check"
                """.trimIndent(),
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("programs.tool.install.script check: file 'scripts/tool-check.sh' not found" in e.message.orEmpty())
        assertTrue("scripts.setup.check: file 'scripts/setup.sh' not found" in e.message.orEmpty())

        fs.createDirectories(repo / "scripts")
        fs.write(repo / "scripts" / "tool-check.sh") { writeUtf8("#!/bin/sh\n") }
        fs.write(repo / "scripts" / "setup.sh") { writeUtf8("#!/bin/sh\n") }
        ManifestLoader.loadRepo(fs, repo)
    }

    @Test
    fun fileInstallValueWithArgumentsValidatesOnlyThePath() {
        val fs = fs(
            mapOf(
                "manifest.toml" to """
                    [programs.tool]
                    [programs.tool.install.script]
                    command = "file:scripts/tool.sh install --verbose"
                """.trimIndent(),
            ),
        )
        // Path token missing -> error names just the path, not the args.
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("file 'scripts/tool.sh' not found" in e.message.orEmpty())

        fs.createDirectories(repo / "scripts")
        fs.write(repo / "scripts" / "tool.sh") { writeUtf8("#!/bin/sh\n") }
        ManifestLoader.loadRepo(fs, repo)
    }

    @Test
    fun templatesWorkAcrossFragments() {
        val fs = fs(
            mapOf(
                "manifest.toml" to """
                    [templates.rpm.version]
                    command = "rpm -q {name}"
                    regex = "([0-9.]+)"

                    [templates.rpm.install.dnf]
                    command = "sudo dnf install -y {name}"
                """.trimIndent(),
                "manifest.d/media.toml" to """
                    [programs.vlc]
                    template = "rpm"
                """.trimIndent(),
                "manifest.d/office.toml" to """
                    [templates.local]
                    packages = ["okular"]

                    [templates.local.install.dnf]
                    command = "sudo dnf install -y {name}"
                """.trimIndent(),
            ),
        )
        val manifest = ManifestLoader.loadRepo(fs, repo)
        assertEquals("rpm -q vlc", manifest.programs.getValue("vlc").version?.command)
        assertEquals("sudo dnf install -y okular", manifest.resolveInstall("okular", "dnf").command)
    }

    @Test
    fun installersMergeFromFragmentsAndDuplicatesFail() {
        val fs = fs(
            mapOf(
                "manifest.toml" to "[meta]\nname = \"x\"",
                "manifest.d/00_installers.toml" to """
                    [installers.dnf]
                    probe = "dnf"
                    install = "sudo dnf install -y {pkg}"
                """.trimIndent(),
                "manifest.d/cli.toml" to """
                    [programs.ripgrep]
                    via = ["dnf"]
                """.trimIndent(),
            ),
        )
        val manifest = ManifestLoader.loadRepo(fs, repo)
        assertEquals("sudo dnf install -y ripgrep", manifest.resolveInstall("ripgrep", "dnf").command)

        val dup = fs(
            mapOf(
                "manifest.toml" to "[installers.dnf]\ninstall = \"a {pkg}\"",
                "manifest.d/extra.toml" to "[installers.dnf]\ninstall = \"b {pkg}\"",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(dup, repo) }
        assertTrue("duplicate installer 'dnf'" in e.message.orEmpty())
    }

    @Test
    fun scriptsArrayAfterPmTableGetsPlacementHint() {
        val fs = fs(
            mapOf(
                "manifest.toml" to "[scripts.s]\nrun = \"echo hi\"",
                "machines/m.toml" to """
                    [pm]
                    scripts = ["s"]
                """.trimIndent(),
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("hint: the top-level `scripts = [...]` array must appear ABOVE" in e.message.orEmpty())
    }

    @Test
    fun machineScriptOptInsAreValidated() {
        val fs = fs(
            mapOf(
                "manifest.toml" to """
                    [scripts.inline]
                    run = "echo hi"
                """.trimIndent(),
                "machines/m.toml" to """
                    scripts = ["ghost", "inline some-arg"]
                """.trimIndent(),
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("unknown script 'ghost'" in e.message.orEmpty())
        assertTrue("arguments require a `file` script" in e.message.orEmpty())
    }

    @Test
    fun minToolVersionIsEnforced() {
        val fs = fs(
            mapOf(
                "manifest.toml" to """
                    [meta]
                    min-tool-version = "999.0.0"

                    [programs.git]
                    [programs.git.install.dnf]
                    command = "x"
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
                    [programs.git.install.dnf]
                    command = "x"
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
                    [programs.git.install.dnf]
                    command = "x"
                """.trimIndent(),
            ),
        )
        val manifest = ManifestLoader.loadRepo(fs, repo)
        assertEquals(setOf("git"), manifest.programs.keys)
        assertTrue(manifest.machines.isEmpty())
    }
}
