package loadout.core

import loadout.core.manifest.ManifestException
import loadout.core.LoadoutException
import loadout.core.engine.ResolutionException
import loadout.core.git.GitException
import loadout.core.manifest.Glob
import loadout.core.manifest.InstallerLibrary
import loadout.core.manifest.MachineData
import loadout.core.manifest.ManifestLoader
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import okio.Path.Companion.toPath
import okio.fakefilesystem.FakeFileSystem

/** Tests for repo loading: the root file's [layout], fragment globs and machine files. */
class ManifestRepoTest {
    private val repo = "/repo".toPath()

    /** Appended to a fixture's loadout.toml unless it declares its own [layout]. */
    private val standardLayout = """

        [layout]
        fragments = ["programs/**/*.toml"]
        machines = "machines"
        state = "state"
    """.trimIndent()

    private fun fs(files: Map<String, String>): FakeFileSystem {
        val fs = FakeFileSystem()
        for ((path, content) in files) {
            val full = repo / path
            full.parent?.let { fs.createDirectories(it) }
            val text = if (path == "loadout.toml" && "[layout]" !in content) content + "\n" + standardLayout else content
            fs.write(full) { writeUtf8(text) }
        }
        return fs
    }

    private fun layoutError(layout: String, vararg extra: Pair<String, String>): String =
        assertFailsWith<ManifestException> {
            ManifestLoader.loadRepo(fs(mapOf("loadout.toml" to "[meta]\nname = \"x\"\n\n$layout") + extra), repo)
        }.message.orEmpty()

    @Test
    fun fragmentsLoadInGlobOrderThenPathOrderEachFileOnce() {
        val fs = fs(
            mapOf(
                "loadout.toml" to """
                    [layout]
                    fragments = ["maintenance/**/*.toml", "programs/**/*.toml", "maintenance/b.toml"]
                    machines = "machines"
                    state = "state"
                """.trimIndent(),
                "programs/z.toml" to "[programs.z]\n[programs.z.install.dnf]\ncommand = \"x\"",
                "programs/a/a.toml" to "[programs.a]\n[programs.a.install.dnf]\ncommand = \"x\"",
                "maintenance/b.toml" to "[programs.b]\n[programs.b.install.dnf]\ncommand = \"x\"",
                "maintenance/a.toml" to "[programs.m]\n[programs.m.install.dnf]\ncommand = \"x\"",
            ),
        )
        // Declaration order is install order's tie-breaker (contract 6).
        assertEquals(listOf("m", "b", "a", "z"), ManifestLoader.loadRepo(fs, repo).programs.keys.toList())
    }

    @Test
    fun dotFragmentsBesideConfigsLoadOnlyWhenTheGlobSpellsTheDot() {
        val fs = fs(
            mapOf(
                "loadout.toml" to """
                    [layout]
                    fragments = ["configs/**/.loadout.toml"]
                    machines = "machines"
                    state = "state"
                """.trimIndent(),
                "configs/private_dot_config/tmux/.loadout.toml" to "[scripts.tmux-plugins]\nrun = \"true\"",
                "configs/private_dot_config/tmux/loadout.toml" to "[scripts.not-a-fragment]\nrun = \"true\"",
                "configs/.chezmoitemplates/x/.loadout.toml" to "[scripts.hidden]\nrun = \"true\"",
            ),
        )
        assertEquals(setOf("tmux-plugins"), ManifestLoader.loadRepo(fs, repo).scripts.keys)
    }

    @Test
    fun globMatchingFollowsTheLayoutRules() {
        assertTrue(Glob.matches("programs/**/*.toml", "programs/a.toml"))
        assertTrue(Glob.matches("programs/**/*.toml", "programs/x/y/a.toml"))
        assertTrue(!Glob.matches("programs/**/*.toml", "programs/a.toml.sample"))
        assertTrue(!Glob.matches("programs/*.toml", "programs/x/a.toml"))
        assertTrue(Glob.matches("programs/?.toml", "programs/a.toml"))
        assertTrue(!Glob.matches("programs/*.toml", "programs/.hidden.toml"))
        assertTrue(!Glob.matches("**/*.toml", ".git/config.toml"))
        assertTrue(Glob.matches("configs/**/.loadout.toml", "configs/private_dot_config/tmux/.loadout.toml"))
    }

    @Test
    fun layoutIsRequiredAndValidated() {
        val missing = assertFailsWith<ManifestException> {
            ManifestLoader.loadRepo(fs(mapOf("loadout.toml" to "[meta]\nname = \"x\"\n[layout]\n")), repo)
        }.message.orEmpty()
        assertTrue("fragments is missing" in missing && "machines is missing" in missing && "state is missing" in missing, missing)

        assertTrue("is empty" in layoutError("[layout]\nfragments = []\nmachines = \"m\"\nstate = \"s\""))
        assertTrue("is absolute" in layoutError("[layout]\nfragments = [\"/etc/*.toml\"]\nmachines = \"m\"\nstate = \"s\""))
        assertTrue("leaves the repo" in layoutError("[layout]\nfragments = [\"../*.toml\"]\nmachines = \"m\"\nstate = \"s\""))
        assertTrue("is a directory, not a glob" in layoutError("[layout]\nfragments = [\"p/*.toml\"]\nmachines = \"m*\"\nstate = \"s\""))
        assertTrue(
            "matches loadout.toml itself" in
                layoutError("[layout]\nfragments = [\"*.toml\"]\nmachines = \"machines\"\nstate = \"state\""),
        )
        assertTrue(
            "matches machine file machines/m.toml" in
                layoutError(
                    "[layout]\nfragments = [\"**/*.toml\"]\nmachines = \"machines\"\nstate = \"state\"",
                    "machines/m.toml" to "[pm]",
                ),
        )
    }

    @Test
    fun aRepoWithoutTheRootFileButWithA0xManifestIsRefusedAsOld() {
        val e = assertFailsWith<ManifestException> {
            ManifestLoader.loadRepo(fs(mapOf("manifest.toml" to "[meta]\nname = \"old\"")), repo)
        }
        assertTrue("loadout 0.x repo" in e.message.orEmpty(), e.message)
    }

    @Test
    fun layoutInAFragmentFails() {
        val fs = fs(
            mapOf(
                "loadout.toml" to "[meta]\nname = \"x\"",
                "programs/extra.toml" to "[layout]\nstate = \"elsewhere\"",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("[layout] is only allowed in loadout.toml" in e.message.orEmpty(), e.message)
    }

    @Test
    fun machinesComeFromTheLayoutDirectory() {
        val fs = fs(
            mapOf(
                "loadout.toml" to """
                    [programs.git]
                    [programs.git.install.dnf]
                    command = "x"

                    [layout]
                    fragments = ["programs/**/*.toml"]
                    machines = "hosts"
                    state = "observed"
                """.trimIndent(),
                "hosts/laptop.toml" to "[pm]\ngit = \"dnf\"",
                "machines/ignored.toml" to "[pm]\ngit = \"dnf\"",
            ),
        )
        assertEquals(setOf("laptop"), ManifestLoader.loadRepo(fs, repo).machines.keys)
        assertEquals("observed", ManifestLoader.readLayout(fs, repo).state)
    }

    @Test
    fun mergesFragmentsAndMachineFiles() {
        val fs = fs(
            mapOf(
                "loadout.toml" to """
                    [meta]
                    name = "split repo"

                    [programs.git]
                    [programs.git.install.dnf]
                    command = "sudo dnf install -y git"
                """.trimIndent(),
                "programs/cli.toml" to """
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
                "loadout.toml" to "[meta]\nname = \"nested\"",
                "programs/dev/editors/kitty.toml" to """
                    [programs.kitty]
                    [programs.kitty.install.dnf]
                    command = "sudo dnf install -y kitty"
                """.trimIndent(),
                "programs/media.toml" to """
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
                "loadout.toml" to "[meta]\nname = \"nested\"",
                "programs/a/tool.toml" to "[programs.tool]\n[programs.tool.install.dnf]\ncommand = \"x\"",
                "programs/b/tool.toml" to "[programs.tool]\n[programs.tool.install.dnf]\ncommand = \"y\"",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("duplicate program 'tool'" in e.message.orEmpty())
        assertTrue("programs/b/tool.toml" in e.message.orEmpty())
    }

    @Test
    fun duplicateProgramAcrossFragmentsFails() {
        val fs = fs(
            mapOf(
                "loadout.toml" to "[programs.git]\n[programs.git.install.dnf]\ncommand = \"x\"",
                "programs/extra.toml" to "[programs.git]\n[programs.git.install.apt]\ncommand = \"y\"",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("duplicate program 'git'" in e.message.orEmpty())
        assertTrue("programs/extra.toml" in e.message.orEmpty())
    }

    @Test
    fun inlineMachinesInRootManifestFails() {
        val fs = fs(
            mapOf(
                "loadout.toml" to """
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
                "loadout.toml" to "[programs.git]\n[programs.git.install.dnf]\ncommand = \"x\"",
                "programs/extra.toml" to "[machines.laptop.pm]\ngit = \"dnf\"",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("[machines.*] sections are not allowed" in e.message.orEmpty())
        assertTrue("programs/extra.toml" in e.message.orEmpty())
    }

    @Test
    fun metaInFragmentFails() {
        val fs = fs(
            mapOf(
                "loadout.toml" to "[programs.git]\n[programs.git.install.dnf]\ncommand = \"x\"",
                "programs/extra.toml" to "[meta]\nname = \"nope\"",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("[meta] is only allowed" in e.message.orEmpty())
    }

    @Test
    fun machineFilesAndBaseInheritance() {
        val fs = fs(
            mapOf(
                "loadout.toml" to """
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
                "machines/fedora.toml" to """
                    base = true
                    scripts = ["dotfiles", "setup-ssh generic"]

                    [pm]
                    git = "dnf"
                    kitty = "dnf"
                """.trimIndent(),
                "machines/laptop.toml" to """
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
    fun aScriptEntryMaySpanLinesAndItsArgumentsReachOneShellLine() {
        val fs = fs(
            mapOf(
                "loadout.toml" to """
                    [scripts.dotfiles]
                    run = "true"
                    [scripts.setup-ssh]
                    file = "scripts/setup-ssh.sh"
                """.trimIndent(),
                "scripts/setup-ssh.sh" to "#!/bin/sh\n",
                "machines/fedora.toml" to """
                    base = true
                    scripts = [
                      '''setup-ssh
                         https://example.com/one.git
                         https://example.com/two.git''',
                      "dotfiles",
                    ]
                """.trimIndent(),
                "machines/laptop.toml" to "extends = \"fedora\"",
                "machines/desktop.toml" to "extends = \"fedora\"\nscripts = ['''setup-ssh\n  only''']",
            ),
        )
        val manifest = ManifestLoader.loadRepo(fs, repo)
        // Newlines and indentation become single spaces: the arguments are
        // pasted into a shell command, where a newline would end it.
        assertEquals(
            mapOf("setup-ssh" to "https://example.com/one.git https://example.com/two.git", "dotfiles" to ""),
            manifest.machines.getValue("laptop").scriptArgs(),
        )
        // A multi-line child entry still replaces the base's by name.
        assertEquals(mapOf("dotfiles" to "", "setup-ssh" to "only"), manifest.machines.getValue("desktop").scriptArgs())
        assertEquals("name" to "a b", loadout.core.model.scriptEntry("  name\n\ta \n  b  "))
    }

    @Test
    fun baseChainsFlattenThroughIntermediateBases() {
        val fs = fs(
            mapOf(
                "loadout.toml" to """
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
            mapOf("loadout.toml" to "[programs.git]\n[programs.git.install.dnf]\ncommand = \"x\"") +
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

        val nested = assertFailsWith<ManifestException> {
            ManifestLoader.loadRepo(
                repoWith(
                    "machines/x/laptop.toml" to "[pm]\ngit = \"dnf\"",
                ),
                repo,
            )
        }
        assertTrue("machines/x/laptop.toml: machine files live directly in machines/" in nested.message.orEmpty(), nested.message)
    }

    @Test
    fun dataDefaultsBaseAndMachineMergeAndUndeclaredKeysFail() {
        val files = mapOf(
            "loadout.toml" to """
                [data]
                omarchy = false
                agent = "claude"
                tags = ["a"]

                [data.kitty]
                opacity = 0.85
                blur = 1
            """.trimIndent(),
            "machines/omarchy.toml" to "base = true\n\n[data]\nomarchy = true\ntags = [\"x\", \"y\"]\n\n[data.kitty]\nblur = 0",
            "machines/t2.toml" to "extends = \"omarchy\"\n\n[data]\ntags = [\"z\"]\n\n[data.kitty]\nopacity = 0.99",
            "machines/mac.toml" to "",
        )
        val manifest = ManifestLoader.loadRepo(fs(files), repo)
        val t2 = MachineData.lines(manifest.machines.getValue("t2").data).toMap()
        // Defaults under base under machine; tables merge key by key, lists replace.
        assertEquals(
            mapOf(
                "agent" to "\"claude\"",
                "kitty.blur" to "0",
                "kitty.opacity" to "0.99",
                "omarchy" to "true",
                "tags" to "[\"z\"]",
            ),
            t2,
        )
        assertEquals("false", MachineData.lines(manifest.machines.getValue("mac").data).toMap()["omarchy"])

        val typo = files + ("machines/mac.toml" to "[data.kitty]\nopacty = 0.5")
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs(typo), repo) }
        assertTrue(
            "machines/mac.toml: [data] key 'kitty.opacty' is not declared in loadout.toml [data]" in e.message.orEmpty(),
            e.message,
        )

        val wrongKind = files + ("machines/mac.toml" to "[data]\nomarchy = \"yes\"")
        val k = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs(wrongKind), repo) }
        assertTrue("[data] key 'omarchy' is a string, but loadout.toml declares a boolean" in k.message.orEmpty(), k.message)

        val inFragment = files + ("programs/x.toml" to "[data]\nomarchy = true")
        val f = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs(inFragment), repo) }
        assertTrue("programs/x.toml: [data] is only allowed in loadout.toml and machine files" in f.message.orEmpty(), f.message)
    }

    @Test
    fun baseMappingsAreValidatedEvenWithoutChildren() {
        val fs = fs(
            mapOf(
                "loadout.toml" to "[programs.git]\n[programs.git.install.dnf]\ncommand = \"x\"",
                "machines/fedora.toml" to "base = true\n\n[pm]\nghost = \"dnf\"",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("unknown program 'ghost'" in e.message.orEmpty())
    }

    @Test
    fun machineFileMappingIsValidatedAgainstMergedPrograms() {
        val fs = fs(
            mapOf(
                "loadout.toml" to "[programs.git]\n[programs.git.install.dnf]\ncommand = \"x\"",
                "machines/laptop.toml" to "[pm]\nghost = \"dnf\"",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("unknown program 'ghost'" in e.message.orEmpty())
    }

    @Test
    fun pathsAreRelativeToTheDeclaringFileAndStayInTheRepo() {
        val tool = """
            [scripts.tmux-plugins]
            file = ".loadout/plugins.sh"
            check = "file:.loadout/plugins.sh check"
        """.trimIndent()
        val files = mapOf(
            "loadout.toml" to """
                [layout]
                fragments = ["configs/**/.loadout.toml"]
                machines = "machines"
                state = "state"
            """.trimIndent(),
            "configs/tmux/.loadout.toml" to tool,
            // At the repo root, where a root-relative reading would look.
            ".loadout/plugins.sh" to "#!/bin/sh\n",
        )
        val missing = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs(files), repo) }
        assertTrue(
            "scripts.tmux-plugins: file '.loadout/plugins.sh' not found (relative to configs/tmux/)" in missing.message.orEmpty(),
            missing.message,
        )

        val loaded = ManifestLoader.loadRepo(fs(files + ("configs/tmux/.loadout/plugins.sh" to "#!/bin/sh\n")), repo)
        assertEquals("configs/tmux", loaded.scripts.getValue("tmux-plugins").origin)

        val escaping = files + ("configs/tmux/.loadout.toml" to "[scripts.x]\nfile = \"../../../outside.sh\"")
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs(escaping), repo) }
        assertTrue("file '../../../outside.sh' leaves the repo" in e.message.orEmpty(), e.message)

        // `..` that stays inside the repo reaches a shared helper.
        val shared = files + mapOf(
            "configs/tmux/.loadout.toml" to "[scripts.x]\nfile = \"../lib/helper.sh\"",
            "configs/lib/helper.sh" to "#!/bin/sh\n",
        )
        assertEquals("../lib/helper.sh", ManifestLoader.loadRepo(fs(shared), repo).scripts.getValue("x").file)
    }

    @Test
    fun anInstallRunsWhereItsCommandWasWritten() {
        val fs = fs(
            mapOf(
                "loadout.toml" to "[meta]\nname = \"x\"",
                "programs/installers/brew.toml" to """
                    [installers.brew]
                    install = "file:brew.sh install {pkg}"
                    check = "file:brew.sh list --versions {pkg}"
                    regex = "([0-9.]+)"
                """.trimIndent(),
                "programs/installers/brew.sh" to "#!/bin/sh\n",
                "programs/cli/tools.toml" to """
                    [programs.jq]
                    via = ["brew"]

                    [programs.odd]
                    [programs.odd.install.brew]
                    command = "file:odd.sh"
                """.trimIndent(),
                "programs/cli/odd.sh" to "#!/bin/sh\n",
            ),
        )
        val manifest = ManifestLoader.loadRepo(fs, repo)
        val jq = manifest.resolveInstall("jq", "brew")
        assertEquals("programs/installers", jq.commandOrigin)
        assertEquals("programs/installers", jq.check?.origin)
        val odd = manifest.resolveInstall("odd", "brew")
        assertEquals("programs/cli", odd.commandOrigin)
        assertEquals("programs/installers", odd.check?.origin)
    }

    @Test
    fun scriptFileMustExistInRepo() {
        val fs = fs(
            mapOf(
                "loadout.toml" to """
                    [scripts.dotfiles]
                    file = "scripts/dotfiles.sh"
                """.trimIndent(),
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("file 'scripts/dotfiles.sh' not found (relative to the repo root)" in e.message.orEmpty())

        fs.createDirectories(repo / "scripts")
        fs.write(repo / "scripts" / "dotfiles.sh") { writeUtf8("#!/bin/sh\n") }
        assertEquals("scripts/dotfiles.sh", ManifestLoader.loadRepo(fs, repo).scripts.getValue("dotfiles").file)
    }

    @Test
    fun fileInstallValueMustExistInRepo() {
        val fs = fs(
            mapOf(
                "loadout.toml" to """
                    [programs.tool]
                    [programs.tool.install.script]
                    command = "file:scripts/install-tool.sh"
                """.trimIndent(),
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue(
            "programs.tool.install.script: file 'scripts/install-tool.sh' not found (relative to the repo root)" in e.message.orEmpty(),
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
                "loadout.toml" to """
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
                "loadout.toml" to """
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
                "loadout.toml" to "[meta]\nname = \"x\"",
                "programs/00_installers.toml" to """
                    [installers.dnf]
                    probe = "dnf"
                    install = "sudo dnf install -y {pkg}"
                """.trimIndent(),
                "programs/cli.toml" to """
                    [programs.ripgrep]
                    via = ["dnf"]
                """.trimIndent(),
            ),
        )
        val manifest = ManifestLoader.loadRepo(fs, repo)
        assertEquals("sudo dnf install -y ripgrep", manifest.resolveInstall("ripgrep", "dnf").command)

        val dup = fs(
            mapOf(
                "loadout.toml" to "[installers.dnf]\ninstall = \"a {pkg}\"",
                "programs/extra.toml" to "[installers.dnf]\ninstall = \"b {pkg}\"",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(dup, repo) }
        assertTrue("duplicate installer 'dnf'" in e.message.orEmpty())
    }

    @Test
    fun scriptsArrayAfterPmTableGetsPlacementHint() {
        val fs = fs(
            mapOf(
                "loadout.toml" to "[scripts.s]\nrun = \"echo hi\"",
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
                "loadout.toml" to """
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
                "loadout.toml" to """
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
        assertTrue("run: loadout self-upgrade" in e.message.orEmpty())
    }

    @Test
    fun minToolVersionAtOrBelowCurrentLoads() {
        val fs = fs(
            mapOf(
                "loadout.toml" to """
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
                "loadout.toml" to """
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
                "loadout.toml" to """
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
                "loadout.toml" to """
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
        val loaded = ManifestLoader.loadRepo(fs(mapOf("loadout.toml" to text)), repo)
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
    fun theShippedDnfMechanismsShareOneRefreshingSweep() {
        // `upgrade` dedupes steps BY COMMAND, so the three dnf mechanisms
        // have to spell theirs identically or one sweep runs three times.
        // And it must refresh: the oracle reads a local cache, so a sweep
        // that trusts yesterday's metadata installs yesterday's versions.
        val sweeps = listOf("dnf", "dnf-repo", "dnf-copr").map { InstallerLibrary.installers[it]?.upgrade }
        assertEquals(listOf("sudo dnf upgrade --refresh -y"), sweeps.distinct())
    }

    @Test
    fun theShippedOmarchyMechanismsShareOneUpdate() {
        // Omarchy's update upgrades repo and AUR packages alike: one step,
        // and never a bare pacman -Syu (Omarchy's hook refuses it).
        val omarchy = listOf("omarchy", "omarchy-aur").map { InstallerLibrary.installers.getValue(it) }
        assertEquals(listOf("omarchy update -y"), omarchy.map { it.upgrade }.distinct())
        assertEquals(listOf("omarchy"), omarchy.map { it.probe }.distinct())
        assertEquals("omarchy pkg add {pkg}", omarchy[0].install)
        assertEquals("omarchy pkg aur add {pkg}", omarchy[1].install)
    }

    @Test
    fun anOmarchyProgramResolvesThroughTheBuiltIn() {
        val manifest = ManifestLoader.loadRepo(
            fs(
                mapOf(
                    "loadout.toml" to "[programs.zsh]\nvia = [\"omarchy\"]\n\n[programs.yay-only]\nvia = [\"omarchy-aur\"]",
                    "machines/t2.toml" to "[pm]\nzsh = \"omarchy\"\nyay-only = \"omarchy-aur\"",
                ),
            ),
            repo,
        )
        assertEquals("omarchy pkg add zsh", manifest.resolveInstall("zsh", "omarchy").command)
        assertEquals("pacman -Q yay-only", manifest.resolveInstall("yay-only", "omarchy-aur").check?.command)
        assertTrue("omarchy" in manifest.builtinInstallers && "omarchy-aur" in manifest.builtinInstallers)
    }

    @Test
    fun theShippedLibraryParsesAndIsUsable() {
        val installers = InstallerLibrary.installers
        assertTrue(installers.keys.containsAll(setOf("dnf", "apt", "pacman", "omarchy", "omarchy-aur", "brew", "brew-cask", "flatpak")))
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
                "loadout.toml" to """
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
