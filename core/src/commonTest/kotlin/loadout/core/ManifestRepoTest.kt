package loadout.core

import loadout.core.manifest.ManifestException
import loadout.core.LoadoutException
import loadout.core.engine.ResolutionException
import loadout.core.git.GitException
import loadout.core.manifest.InstallerLibrary
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
    fun machineFilesInSubfoldersAndBaseInheritance() {
        val fs = fs(
            mapOf(
                "manifest.toml" to """
                    [programs.git]
                    [programs.git.install.dnf]
                    command = "x"
                    [programs.git.install.brew]
                    command = "y"
                    [programs.kitty]
                    [programs.kitty.install.dnf]
                    command = "z"

                    [scripts.dotfiles]
                    run = "true"
                    [scripts.setup-ssh]
                    file = "scripts/setup-ssh.sh"
                """.trimIndent(),
                "scripts/setup-ssh.sh" to "#!/bin/sh\n",
                "machines/base/fedora.toml" to """
                    base = true
                    scripts = ["dotfiles", "setup-ssh generic"]

                    [pm]
                    git = "dnf"
                    kitty = "dnf"
                """.trimIndent(),
                "machines/linux/laptop.toml" to """
                    extends = "fedora"
                    scripts = ["setup-ssh laptopkey"]

                    [pm]
                    git = "brew"
                """.trimIndent(),
            ),
        )
        val manifest = ManifestLoader.loadRepo(fs, repo)
        // Bases are not machines.
        assertEquals(setOf("laptop"), manifest.machines.keys)
        val laptop = manifest.machines.getValue("laptop")
        // pm merged per key, child wins.
        assertEquals("brew", laptop.pm["git"])
        assertEquals("dnf", laptop.pm["kitty"])
        // scripts union; same-named child entry replaces the base's (args too).
        assertEquals(mapOf("dotfiles" to "", "setup-ssh" to "laptopkey"), laptop.scriptArgs())
    }

    @Test
    fun baseChainsFlattenThroughIntermediateBases() {
        val fs = fs(
            mapOf(
                "manifest.toml" to """
                    [programs.git]
                    [programs.git.install.dnf]
                    command = "x"
                    [programs.git.install.rpm-ostree]
                    command = "y"
                """.trimIndent(),
                "machines/fedora.toml" to "base = true\n\n[pm]\ngit = \"dnf\"",
                "machines/fedora-atomic.toml" to "base = true\nextends = \"fedora\"\n\n[pm]\ngit = \"rpm-ostree\"",
                "machines/deck.toml" to "extends = \"fedora-atomic\"",
            ),
        )
        val manifest = ManifestLoader.loadRepo(fs, repo)
        assertEquals(setOf("deck"), manifest.machines.keys)
        assertEquals("rpm-ostree", manifest.machines.getValue("deck").pm["git"])
    }

    @Test
    fun machineInheritanceErrors() {
        fun repoWith(vararg machineFiles: Pair<String, String>) = fs(
            mapOf("manifest.toml" to "[programs.git]\n[programs.git.install.dnf]\ncommand = \"x\"") +
                machineFiles.toMap(),
        )

        val unknown = assertFailsWith<ManifestException> {
            ManifestLoader.loadRepo(repoWith("machines/laptop.toml" to "extends = \"ghost\""), repo)
        }
        assertTrue("extends unknown base 'ghost'" in unknown.message.orEmpty())

        val notABase = assertFailsWith<ManifestException> {
            ManifestLoader.loadRepo(
                repoWith(
                    "machines/laptop.toml" to "[pm]\ngit = \"dnf\"",
                    "machines/desktop.toml" to "extends = \"laptop\"",
                ),
                repo,
            )
        }
        assertTrue("is not a base" in notABase.message.orEmpty())

        val cycle = assertFailsWith<ManifestException> {
            ManifestLoader.loadRepo(
                repoWith(
                    "machines/a.toml" to "base = true\nextends = \"b\"",
                    "machines/b.toml" to "base = true\nextends = \"a\"",
                ),
                repo,
            )
        }
        assertTrue("cycle" in cycle.message.orEmpty())

        val dup = assertFailsWith<ManifestException> {
            ManifestLoader.loadRepo(
                repoWith(
                    "machines/x/laptop.toml" to "[pm]\ngit = \"dnf\"",
                    "machines/y/laptop.toml" to "[pm]\ngit = \"dnf\"",
                ),
                repo,
            )
        }
        assertTrue("duplicate machine 'laptop'" in dup.message.orEmpty())
    }

    @Test
    fun baseMappingsAreValidatedEvenWithoutChildren() {
        val fs = fs(
            mapOf(
                "manifest.toml" to "[programs.git]\n[programs.git.install.dnf]\ncommand = \"x\"",
                "machines/base/fedora.toml" to "base = true\n\n[pm]\nghost = \"dnf\"",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("unknown program 'ghost'" in e.message.orEmpty())
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
        assertTrue("run: loadout upgrade" in e.message.orEmpty())
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

    @Test
    fun builtInInstallersResolveWithoutBeingDeclared() {
        val fs = fs(
            mapOf(
                "manifest.toml" to """
                    [programs.ripgrep]
                    via = ["dnf"]
                """.trimIndent(),
                "machines/laptop.toml" to """
                    [pm]
                    ripgrep = "dnf"
                """.trimIndent(),
            ),
        )

        val manifest = ManifestLoader.loadRepo(fs, repo)
        val resolved = manifest.resolveInstall("ripgrep", "dnf")
        assertEquals("sudo dnf install -y ripgrep", resolved.command)
        assertEquals("rpm -q ripgrep", resolved.check?.command)
        assertEquals("dnf", resolved.probe)
        assertTrue("dnf" in manifest.builtinInstallers)
    }

    @Test
    fun repoInstallerReplacesTheBuiltInOfTheSameName() {
        val fs = fs(
            mapOf(
                "manifest.toml" to """
                    [installers.dnf]
                    probe = "dnf5"
                    install = "sudo dnf5 install -y {pkg}"
                    check = "rpm -q {pkg}"
                    regex = "([0-9.]+)"

                    [programs.ripgrep]
                    via = ["dnf"]
                """.trimIndent(),
                "machines/laptop.toml" to """
                    [pm]
                    ripgrep = "dnf"
                """.trimIndent(),
            ),
        )

        val manifest = ManifestLoader.loadRepo(fs, repo)
        assertEquals("sudo dnf5 install -y ripgrep", manifest.resolveInstall("ripgrep", "dnf").command)
        // Overridden: no longer reported as built-in, and the built-in's
        // outdated oracle is gone with it (replaced outright, not merged).
        assertTrue("dnf" !in manifest.builtinInstallers)
        assertEquals(null, manifest.installers.getValue("dnf").outdatedAll)
        assertTrue("brew" in manifest.builtinInstallers)
    }

    @Test
    fun parseAndLoadRepoResolveInstallsIdentically() {
        // parse() is test-only and deliberately laxer (inline [machines.*],
        // no file: existence check) — but if it disagreed about INSTALLERS,
        // every engine test would be exercising a resolution production never
        // performs. Both go through withBuiltinInstallers.
        val text = """
            [programs.ripgrep]
            via = ["dnf"]
        """.trimIndent()
        val parsed = ManifestLoader.parse(text)
        val loaded = ManifestLoader.loadRepo(fs(mapOf("manifest.toml" to text)), repo)
        assertEquals(
            loaded.resolveInstall("ripgrep", "dnf"),
            parsed.resolveInstall("ripgrep", "dnf"),
        )
        assertEquals(loaded.builtinInstallers, parsed.builtinInstallers)
    }

    @Test
    fun theShippedLibraryCarriesNoDeadPerPackageOracle() {
        // A batch oracle always wins over the per-pkg one (resolveInstall),
        // so an installer declaring both would ship a command that can never
        // run. Repos may still keep both — old binaries ignore outdated-all.
        for ((name, installer) in InstallerLibrary.installers) {
            if (installer.outdatedAll != null) {
                assertEquals(null, installer.outdated, "$name declares an unreachable per-pkg oracle")
            }
        }
    }

    @Test
    fun theShippedLibraryParsesAndIsUsable() {
        val installers = InstallerLibrary.installers
        assertTrue(installers.keys.containsAll(setOf("dnf", "apt", "pacman", "brew", "brew-cask", "flatpak")))
        for ((name, installer) in installers) {
            assertTrue(installer.probe != null, "$name has no probe")
            assertTrue(installer.install?.contains("{pkg}") == true, "$name install ignores {pkg}")
            assertTrue(installer.check?.contains("{pkg}") == true, "$name check ignores {pkg}")
            assertTrue(installer.regex != null, "$name has no regex")
        }
    }

    @Test
    fun aTemplatedManifestFailsLoudlyInsteadOfLoadingEmpty() {
        val fs = fs(
            mapOf(
                "manifest.toml" to """
                    [templates.rpm]
                    packages = ["vlc"]
                    [templates.rpm.install.dnf]
                    command = "sudo dnf install -y {name}"
                """.trimIndent(),
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue(e.message!!.contains("removed in loadout 0.9.0"), e.message!!)
    }

    @Test
    fun everyLoadoutFailureReportsAsACleanOneLiner() {
        // Main.kt catches LoadoutException and nothing else of ours; a type
        // that escapes this hierarchy would reach the user as a stack trace.
        val ours: List<Exception> = listOf(
            ManifestException("x"),
            ResolutionException("x"),
            GitException("x"),
        )
        for (e in ours) assertTrue(e is LoadoutException, "${e::class.simpleName} is not a LoadoutException")
    }
}
