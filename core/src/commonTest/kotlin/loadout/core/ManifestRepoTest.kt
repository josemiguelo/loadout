package loadout.core

import loadout.core.manifest.ManifestException
import loadout.core.LoadoutException
import loadout.core.engine.ConfigException
import loadout.core.engine.ResolutionException
import loadout.core.git.GitException
import loadout.core.manifest.Glob
import loadout.core.manifest.InstallerLibrary
import loadout.core.manifest.MachineData
import loadout.core.manifest.ManifestLoader
import loadout.core.model.MachineGroup
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import okio.Path.Companion.toPath
import okio.fakefilesystem.FakeFileSystem

/** Tests for repo loading: the root file's layout, fragment globs and machine files. */
class ManifestRepoTest {
    private val repo = "/repo".toPath()

    /** Appended to a fixture's loadout.yaml unless it declares its own top-level layout. */
    private val standardLayout = """
        layout:
          fragments: [programs/**/*.yaml]
          machines: machines
          profiles: profiles
          state: state
    """.trimIndent()

    private fun fs(files: Map<String, String>): FakeFileSystem {
        val fs = FakeFileSystem()
        for ((path, content) in files) {
            val full = repo / path
            full.parent?.let { fs.createDirectories(it) }
            val text = if (path == "loadout.yaml" && !hasLayout(content)) content + "\n" + standardLayout else content
            fs.write(full) { writeUtf8(text) }
        }
        return fs
    }

    /** Whether a root file declares its own top-level `layout:` key. */
    private fun hasLayout(content: String): Boolean = Regex("(?m)^layout:").containsMatchIn(content)

    private fun layoutError(layout: String, vararg extra: Pair<String, String>): String =
        assertFailsWith<ManifestException> {
            ManifestLoader.loadRepo(fs(mapOf("loadout.yaml" to "meta:\n  name: x\n\n$layout") + extra), repo)
        }.message.orEmpty()

    @Test
    fun fragmentsLoadInGlobOrderThenPathOrderEachFileOnce() {
        val fs = fs(
            mapOf(
                "loadout.yaml" to """
                    layout:
                      fragments: [maintenance/**/*.yaml, programs/**/*.yaml, maintenance/b.yaml]
                      machines: machines
                      state: state
                """.trimIndent(),
                "programs/z.yaml" to "install:\n  dnf:\n    command: x",
                "programs/a/a.yaml" to "install:\n  dnf:\n    command: x",
                "maintenance/b.yaml" to "install:\n  dnf:\n    command: x",
                "maintenance/a.loadout.yaml" to "programs:\n  m:\n    install:\n      dnf:\n        command: x",
            ),
        )
        // Declaration order is install order's tie-breaker (contract 6).
        assertEquals(listOf("m", "b", "a", "z"), ManifestLoader.loadRepo(fs, repo).programs.keys.toList())
    }

    @Test
    fun dotFragmentsBesideConfigsLoadOnlyWhenTheGlobSpellsTheDot() {
        val fs = fs(
            mapOf(
                "loadout.yaml" to """
                    layout:
                      fragments: [configs/**/.loadout.yaml]
                      machines: machines
                      state: state
                """.trimIndent(),
                "configs/private_dot_config/tmux/.loadout.yaml" to "scripts:\n  tmux-plugins:\n    run: true",
                "configs/private_dot_config/tmux/loadout.yaml" to "scripts:\n  not-a-fragment:\n    run: true",
                "configs/.chezmoitemplates/x/.loadout.yaml" to "scripts:\n  hidden:\n    run: true",
            ),
        )
        assertEquals(setOf("tmux-plugins"), ManifestLoader.loadRepo(fs, repo).scripts.keys)
    }

    @Test
    fun globMatchingFollowsTheLayoutRules() {
        assertTrue(Glob.matches("programs/**/*.yaml", "programs/a.yaml"))
        assertTrue(Glob.matches("programs/**/*.yaml", "programs/x/y/a.yaml"))
        assertTrue(!Glob.matches("programs/**/*.yaml", "programs/a.yaml.sample"))
        assertTrue(!Glob.matches("programs/*.yaml", "programs/x/a.yaml"))
        assertTrue(Glob.matches("programs/?.yaml", "programs/a.yaml"))
        assertTrue(!Glob.matches("programs/*.yaml", "programs/.hidden.yaml"))
        assertTrue(!Glob.matches("**/*.yaml", ".git/config.yaml"))
        assertTrue(Glob.matches("configs/**/.loadout.yaml", "configs/private_dot_config/tmux/.loadout.yaml"))
    }

    @Test
    fun layoutIsRequiredAndValidated() {
        val missing = assertFailsWith<ManifestException> {
            ManifestLoader.loadRepo(fs(mapOf("loadout.yaml" to "meta:\n  name: x\nlayout: {}")), repo)
        }.message.orEmpty()
        assertTrue("fragments is missing" in missing && "machines is missing" in missing && "state is missing" in missing, missing)

        assertTrue("is empty" in layoutError("layout:\n  fragments: []\n  machines: m\n  state: s"))
        assertTrue("is absolute" in layoutError("layout:\n  fragments: [/etc/*.yaml]\n  machines: m\n  state: s"))
        assertTrue("leaves the repo" in layoutError("layout:\n  fragments: [../*.yaml]\n  machines: m\n  state: s"))
        assertTrue("is a directory, not a glob" in layoutError("layout:\n  fragments: [p/*.yaml]\n  machines: m*\n  state: s"))
        assertTrue(
            "matches loadout.yaml itself" in
                layoutError("layout:\n  fragments: ['*.yaml']\n  machines: machines\n  state: state"),
        )
        assertTrue(
            "matches machine file machines/m.yaml" in
                layoutError(
                    "layout:\n  fragments: ['**/*.yaml']\n  machines: machines\n  state: state",
                    "machines/m.yaml" to "",
                ),
        )
    }

    @Test
    fun aRootNotNamedLoadoutYamlIsNotFound() {
        val e = assertFailsWith<ManifestException> {
            ManifestLoader.loadRepo(fs(mapOf("loadout.yml" to "meta:\n  name: old")), repo)
        }
        assertTrue("Manifest not found" in e.message.orEmpty(), e.message)
        assertTrue("loadout.yaml" in e.message.orEmpty(), e.message)
    }

    @Test
    fun layoutInAFragmentFails() {
        val fs = fs(
            mapOf(
                "loadout.yaml" to "meta:\n  name: x",
                "programs/extra.loadout.yaml" to "layout:\n  state: elsewhere",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("programs/extra.loadout.yaml: unknown section 'layout'" in e.message.orEmpty(), e.message)
    }

    @Test
    fun machinesComeFromTheLayoutDirectory() {
        val fs = fs(
            mapOf(
                "loadout.yaml" to """
                    programs:
                      git:
                        install:
                          dnf:
                            command: x

                    layout:
                      fragments: [programs/**/*.yaml]
                      machines: hosts
                      state: observed
                """.trimIndent(),
                "hosts/laptop.yaml" to "git:\n  install_with: dnf",
                "machines/ignored.yaml" to "git:\n  install_with: dnf",
            ),
        )
        assertEquals(setOf("laptop"), ManifestLoader.loadRepo(fs, repo).machines.keys)
        assertEquals("observed", ManifestLoader.readLayout(fs, repo).state)
    }

    @Test
    fun mergesFragmentsAndMachineFiles() {
        val fs = fs(
            mapOf(
                "loadout.yaml" to """
                    meta:
                      name: split repo

                    programs:
                      git:
                        install:
                          dnf:
                            command: sudo dnf install -y git
                """.trimIndent(),
                "programs/cli.loadout.yaml" to """
                    programs:
                      ripgrep:
                        depends-on: [git]
                        install:
                          dnf:
                            command: sudo dnf install -y ripgrep

                    scripts:
                      marker:
                        run: true
                """.trimIndent(),
                "machines/laptop.yaml" to """
                    git:
                      install_with: dnf

                    ripgrep:
                      install_with: dnf
                """.trimIndent(),
            ),
        )

        val manifest = ManifestLoader.loadRepo(fs, repo)
        assertEquals("split repo", manifest.meta.name)
        assertEquals(setOf("git", "ripgrep"), manifest.programs.keys)
        assertEquals(setOf("marker"), manifest.scripts.keys)
        // Machine file name (minus .yaml) becomes the machine name; cross-file refs validate.
        assertEquals("dnf", manifest.machines.getValue("laptop").pm["ripgrep"])
    }

    @Test
    fun fragmentsInSubfoldersAreMerged() {
        val fs = fs(
            mapOf(
                "loadout.yaml" to "meta:\n  name: nested",
                "programs/dev/editors/kitty.yaml" to "install:\n  dnf:\n    command: sudo dnf install -y kitty",
                "programs/media.loadout.yaml" to """
                    programs:
                      vlc:
                        install:
                          dnf:
                            command: sudo dnf install -y vlc
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
                "loadout.yaml" to "meta:\n  name: nested",
                "programs/a/tool.yaml" to "install:\n  dnf:\n    command: x",
                "programs/b/tool.yaml" to "install:\n  dnf:\n    command: y",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("duplicate program 'tool'" in e.message.orEmpty())
        assertTrue("programs/b/tool.yaml" in e.message.orEmpty())
    }

    @Test
    fun duplicateProgramAcrossFragmentsFails() {
        val fs = fs(
            mapOf(
                "loadout.yaml" to "programs:\n  git:\n    install:\n      dnf:\n        command: x",
                "programs/extra.loadout.yaml" to "programs:\n  git:\n    install:\n      apt:\n        command: y",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("duplicate program 'git'" in e.message.orEmpty())
        assertTrue("programs/extra.loadout.yaml" in e.message.orEmpty())
    }

    @Test
    fun inlineMachinesInRootManifestFails() {
        val fs = fs(
            mapOf(
                "loadout.yaml" to """
                    programs:
                      git:
                        install:
                          dnf:
                            command: x

                    machines:
                      laptop:
                        pm:
                          git: dnf
                """.trimIndent(),
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("machines sections are not allowed" in e.message.orEmpty())
    }

    @Test
    fun inlineMachinesInFragmentFails() {
        val fs = fs(
            mapOf(
                "loadout.yaml" to "programs:\n  git:\n    install:\n      dnf:\n        command: x",
                "programs/extra.loadout.yaml" to "machines:\n  laptop:\n    pm:\n      git: dnf",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("programs/extra.loadout.yaml: unknown section 'machines'" in e.message.orEmpty(), e.message)
    }

    @Test
    fun metaInFragmentFails() {
        val fs = fs(
            mapOf(
                "loadout.yaml" to "programs:\n  git:\n    install:\n      dnf:\n        command: x",
                "programs/extra.loadout.yaml" to "meta:\n  name: nope",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("programs/extra.loadout.yaml: unknown section 'meta'" in e.message.orEmpty(), e.message)
    }

    @Test
    fun machineFilesAndBaseInheritance() {
        val fs = fs(
            mapOf(
                "loadout.yaml" to """
                    programs:
                      git:
                        install:
                          dnf:
                            command: x
                          brew:
                            command: y
                      kitty:
                        install:
                          dnf:
                            command: z

                    scripts:
                      dotfiles:
                        run: true
                      setup-ssh:
                        file: scripts/setup-ssh.sh
                """.trimIndent(),
                "scripts/setup-ssh.sh" to "#!/bin/sh\n",
                "profiles/fedora.yaml" to """
                    dotfiles:
                      scripts: [dotfiles]

                    ssh:
                      scripts: [setup-ssh generic]

                    git:
                      install_with: dnf

                    kitty:
                      install_with: dnf
                """.trimIndent(),
                "machines/laptop.yaml" to """
                    extends: [fedora]

                    ssh:
                      scripts: [setup-ssh laptopkey]

                    git:
                      install_with: brew
                """.trimIndent(),
            ),
        )
        val manifest = ManifestLoader.loadRepo(fs, repo)
        // Profiles are not machines.
        assertEquals(setOf("laptop"), manifest.machines.keys)
        val laptop = manifest.machines.getValue("laptop")
        // Mappings merge per program, the machine wins.
        assertEquals("brew", laptop.pm["git"])
        assertEquals("dnf", laptop.pm["kitty"])
        // Opt-ins union; a same-named machine entry replaces the profile's (args too).
        assertEquals(mapOf("dotfiles" to "", "setup-ssh" to "laptopkey"), laptop.scriptArgs())
    }

    @Test
    fun aScriptEntryMaySpanLinesAndItsArgumentsReachOneShellLine() {
        val fs = fs(
            mapOf(
                "loadout.yaml" to """
                    scripts:
                      dotfiles:
                        run: true
                      setup-ssh:
                        file: scripts/setup-ssh.sh
                """.trimIndent(),
                "scripts/setup-ssh.sh" to "#!/bin/sh\n",
                "profiles/fedora.yaml" to """
                    setup:
                      scripts:
                        - setup-ssh
                          https://example.com/one.git
                          https://example.com/two.git
                        - dotfiles
                """.trimIndent(),
                "machines/laptop.yaml" to "extends: [fedora]",
                "machines/desktop.yaml" to """
                    extends: [fedora]

                    ssh:
                      scripts:
                        - 'setup-ssh
                          only'
                """.trimIndent(),
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
    fun profileChainsFlattenThroughIntermediateProfiles() {
        val fs = fs(
            mapOf(
                "loadout.yaml" to """
                    programs:
                      git:
                        install:
                          dnf:
                            command: x
                          rpm-ostree:
                            command: y
                """.trimIndent(),
                "profiles/fedora.yaml" to "git:\n  install_with: dnf",
                "profiles/fedora-atomic.yaml" to "extends: [fedora]\n\ngit:\n  install_with: rpm-ostree",
                "machines/deck.yaml" to "extends: [fedora-atomic]",
            ),
        )
        val manifest = ManifestLoader.loadRepo(fs, repo)
        assertEquals(setOf("deck"), manifest.machines.keys)
        assertEquals("rpm-ostree", manifest.machines.getValue("deck").pm["git"])
    }

    @Test
    fun machineInheritanceErrors() {
        fun repoWith(vararg machineFiles: Pair<String, String>) = fs(
            mapOf("loadout.yaml" to "programs:\n  git:\n    install:\n      dnf:\n        command: x") +
                machineFiles.toMap(),
        )

        val unknown = assertFailsWith<ManifestException> {
            ManifestLoader.loadRepo(repoWith("machines/laptop.yaml" to "extends: [ghost]"), repo)
        }
        assertTrue(
            "machines/laptop.yaml: extends unknown profile 'ghost' (no profiles/ghost.yaml)" in unknown.message.orEmpty(),
            unknown.message,
        )

        // A machine is never a profile: extends looks in profiles/ only.
        val aMachine = assertFailsWith<ManifestException> {
            ManifestLoader.loadRepo(
                repoWith(
                    "machines/laptop.yaml" to "git:\n  install_with: dnf",
                    "machines/desktop.yaml" to "extends: [laptop]",
                ),
                repo,
            )
        }
        assertTrue("extends unknown profile 'laptop'" in aMachine.message.orEmpty(), aMachine.message)

        val notAList = assertFailsWith<ManifestException> {
            ManifestLoader.loadRepo(repoWith("profiles/p.yaml" to "", "machines/laptop.yaml" to "extends: p"), repo)
        }
        assertTrue("machines/laptop.yaml: extends is a list of strings" in notAList.message.orEmpty(), notAList.message)

        // The old `base = true` flag is no longer an entry: it is rejected as a non-mapping.
        val oldBase = assertFailsWith<ManifestException> {
            ManifestLoader.loadRepo(repoWith("profiles/p.yaml" to "base: true"), repo)
        }
        assertTrue("profiles/p.yaml: base must be a mapping" in oldBase.message.orEmpty(), oldBase.message)

        val cycle = assertFailsWith<ManifestException> {
            ManifestLoader.loadRepo(
                repoWith(
                    "profiles/a.yaml" to "extends: [b]",
                    "profiles/b.yaml" to "extends: [a]",
                ),
                repo,
            )
        }
        assertTrue("cycle" in cycle.message.orEmpty())

        val nested = assertFailsWith<ManifestException> {
            ManifestLoader.loadRepo(
                repoWith(
                    "machines/x/laptop.yaml" to "git:\n  install_with: dnf",
                ),
                repo,
            )
        }
        assertTrue(
            "machines/x/laptop.yaml: machine files live directly in machines/" in nested.message.orEmpty(),
            nested.message,
        )
    }

    @Test
    fun dataDefaultsProfilesAndMachineMergeAndUndeclaredKeysFail() {
        val files = mapOf(
            "loadout.yaml" to """
                data:
                  omarchy: false
                  agent: claude
                  tags: [a]
                  kitty:
                    opacity: 0.85
                    blur: 1
            """.trimIndent(),
            "profiles/omarchy.yaml" to """
                data:
                  omarchy: true
                  tags: [x, y]
                  kitty:
                    blur: 0
            """.trimIndent(),
            // The machine's nested kitty table merges key by key with the profile's.
            "machines/t2.yaml" to """
                extends: [omarchy]

                data:
                  tags: [z]
                  kitty:
                    opacity: 0.99
            """.trimIndent(),
            "machines/mac.yaml" to "",
        )
        val manifest = ManifestLoader.loadRepo(fs(files), repo)
        val t2 = MachineData.lines(manifest.machines.getValue("t2").data).toMap()
        // Defaults under profile under machine; tables merge key by key, lists replace.
        // Decimals are numbers in `data`, like whole numbers.
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

        val typo = files + ("machines/mac.yaml" to "data:\n  kitty:\n    opacty: 0.5")
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs(typo), repo) }
        assertTrue(
            "machines/mac.yaml: data key 'kitty.opacty' is not declared in loadout.yaml" in e.message.orEmpty(),
            e.message,
        )

        val wrongKind = files + ("machines/mac.yaml" to "data:\n  omarchy: \"yes\"")
        val k = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs(wrongKind), repo) }
        assertTrue(
            "machines/mac.yaml: data key 'omarchy' is a string, but loadout.yaml declares a boolean" in k.message.orEmpty(),
            k.message,
        )

        // A program file is one program: a `data` key there is an unknown field.
        val inFragment = files + ("programs/x.yaml" to "data:\n  omarchy: true")
        val f = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs(inFragment), repo) }
        assertTrue("Failed to parse programs/x.yaml" in f.message.orEmpty(), f.message)
        assertTrue("unknown key 'data'" in f.message.orEmpty(), f.message)
    }

    @Test
    fun profileMappingsAreValidatedEvenWithoutMachines() {
        val fs = fs(
            mapOf(
                "loadout.yaml" to "programs:\n  git:\n    install:\n      dnf:\n        command: x",
                "profiles/fedora.yaml" to "ghost:\n  install_with: dnf",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("profiles/fedora.yaml references unknown program 'ghost'" in e.message.orEmpty(), e.message)
    }

    @Test
    fun machineFileMappingIsValidatedAgainstMergedPrograms() {
        val fs = fs(
            mapOf(
                "loadout.yaml" to "programs:\n  git:\n    install:\n      dnf:\n        command: x",
                "machines/laptop.yaml" to "ghost:\n  install_with: dnf",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }
        assertTrue("unknown program 'ghost'" in e.message.orEmpty())
    }

    @Test
    fun pathsAreRelativeToTheDeclaringFileAndStayInTheRepo() {
        val tool = """
            scripts:
              tmux-plugins:
                file: .loadout/plugins.sh
                check: file:.loadout/plugins.sh check
        """.trimIndent()
        val files = mapOf(
            "loadout.yaml" to """
                layout:
                  fragments: [configs/**/.loadout.yaml]
                  machines: machines
                  state: state
            """.trimIndent(),
            "configs/tmux/.loadout.yaml" to tool,
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

        val escaping = files + ("configs/tmux/.loadout.yaml" to "scripts:\n  x:\n    file: ../../../outside.sh")
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs(escaping), repo) }
        assertTrue("file '../../../outside.sh' leaves the repo" in e.message.orEmpty(), e.message)

        // `..` that stays inside the repo reaches a shared helper.
        val shared = files + mapOf(
            "configs/tmux/.loadout.yaml" to "scripts:\n  x:\n    file: ../lib/helper.sh",
            "configs/lib/helper.sh" to "#!/bin/sh\n",
        )
        assertEquals("../lib/helper.sh", ManifestLoader.loadRepo(fs(shared), repo).scripts.getValue("x").file)
    }

    @Test
    fun anInstallRunsWhereItsCommandWasWritten() {
        val fs = fs(
            mapOf(
                "loadout.yaml" to "meta:\n  name: x",
                "programs/installers/brew.loadout.yaml" to """
                    installers:
                      brew:
                        install: file:brew.sh install {pkg}
                        check: file:brew.sh list --versions {pkg}
                        regex: '([0-9.]+)'
                """.trimIndent(),
                "programs/installers/brew.sh" to "#!/bin/sh\n",
                "programs/cli/tools.loadout.yaml" to """
                    programs:
                      jq:
                        via: [brew]
                      odd:
                        install:
                          brew:
                            command: file:odd.sh
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
                "loadout.yaml" to """
                    scripts:
                      dotfiles:
                        file: scripts/dotfiles.sh
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
                "loadout.yaml" to """
                    programs:
                      tool:
                        install:
                          script:
                            command: file:scripts/install-tool.sh
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
                "loadout.yaml" to """
                    programs:
                      tool:
                        install:
                          script:
                            command: true
                            check: file:scripts/tool-check.sh check
                            regex: '([0-9.]+)'

                    scripts:
                      setup:
                        run: true
                        check: file:scripts/setup.sh check
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
                "loadout.yaml" to """
                    programs:
                      tool:
                        install:
                          script:
                            command: file:scripts/tool.sh install --verbose
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
    fun aFileMarkedWithValueIsAPathNextToItsProgram() {
        val files = mapOf(
            "loadout.yaml" to "meta:\n  name: x",
            "programs/apps/editors.loadout.yaml" to """
                programs:
                  code:
                    install:
                      dnf-repo:
                        with:
                          repofile: file:repos/vscode.repo

                  teams:
                    install:
                      dnf-repo:
                        with:
                          repofile: https://example.com/teams.repo
            """.trimIndent(),
            "programs/apps/repos/vscode.repo" to "[code]\n",
        )
        val manifest = ManifestLoader.loadRepo(fs(files), repo)
        // Resolved next to editors.loadout.yaml, substituted where the built-in pattern
        // (run from the repo root, or anywhere) still finds it.
        assertEquals(
            "sudo dnf config-manager addrepo --overwrite --from-repofile=\$LOADOUT_REPO/programs/apps/repos/vscode.repo && sudo dnf install -y code",
            manifest.resolveInstall("code", "dnf-repo").command,
        )
        // Unmarked values (a URL) pass through as written.
        assertTrue("--from-repofile=https://example.com/teams.repo" in manifest.resolveInstall("teams", "dnf-repo").command.orEmpty())

        val missing = files - "programs/apps/repos/vscode.repo"
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs(missing), repo) }
        assertTrue(
            "programs.code.install.dnf-repo.with.repofile: file 'repos/vscode.repo' not found (relative to programs/apps/)" in e.message.orEmpty(),
            e.message,
        )
    }

    @Test
    fun installersMergeFromFragmentsAndDuplicatesFail() {
        val fs = fs(
            mapOf(
                "loadout.yaml" to "meta:\n  name: x",
                "programs/00_installers.loadout.yaml" to """
                    installers:
                      dnf:
                        probe: dnf
                        install: sudo dnf install -y {pkg}
                """.trimIndent(),
                "programs/cli.loadout.yaml" to """
                    programs:
                      ripgrep:
                        via: [dnf]
                """.trimIndent(),
            ),
        )
        val manifest = ManifestLoader.loadRepo(fs, repo)
        assertEquals("sudo dnf install -y ripgrep", manifest.resolveInstall("ripgrep", "dnf").command)

        val dup = fs(
            mapOf(
                "loadout.yaml" to "installers:\n  dnf:\n    install: a {pkg}",
                "programs/extra.loadout.yaml" to "installers:\n  dnf:\n    install: b {pkg}",
            ),
        )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(dup, repo) }
        assertTrue("duplicate installer 'dnf'" in e.message.orEmpty())
    }

    @Test
    fun groupsMapProgramsAndOptInScriptsAndRefuseWhatTheyDontKnow() {
        val files = mapOf(
            "loadout.yaml" to """
                scripts:
                  s:
                    run: echo hi
                programs:
                  tmux:
                    install:
                      omarchy: {}
                  tpack:
                    install:
                      brew-cask: {}
            """.trimIndent(),
            // One entry maps one program: its install_with, and the scripts it opts into.
            "machines/m.yaml" to """
                tmux:
                  install_with: omarchy
                  scripts: [s]
                tpack:
                  install_with: brew-cask
            """.trimIndent(),
        )
        val m = ManifestLoader.loadRepo(fs(files), repo).machines.getValue("m")
        assertEquals(mapOf("tmux" to "omarchy", "tpack" to "brew-cask"), m.pm)
        assertEquals(listOf("s"), m.scripts)
        assertEquals(setOf("tmux", "tpack"), m.groups.keys)

        fun error(machine: String) = assertFailsWith<ManifestException> {
            ManifestLoader.loadRepo(fs(files + ("machines/m.yaml" to machine)), repo)
        }.message.orEmpty()
        assertTrue("machines/m.yaml: script 's' is opted into twice ([a] and [b])" in
            error("a:\n  scripts: [s]\nb:\n  scripts: [s]"))
        assertTrue("machines/m.yaml: tmux has unknown key 'pkg' (install_with, scripts)" in error("tmux:\n  pkg: x"))
        assertTrue("machines/m.yaml: scripts must be a mapping (install_with, scripts)" in error("scripts: [s]"))
    }

    @Test
    fun topLevelInstallWithListsProgramsPerVariant() {
        val files = mapOf(
            "loadout.yaml" to """
                scripts:
                  s:
                    run: echo hi
                programs:
                  tmux:
                    install:
                      omarchy: {}
                  tpack:
                    install:
                      brew-cask: {}
                  git:
                    install:
                      omarchy: {}
            """.trimIndent(),
            // A listed program keeps an entry of its own for its scripts.
            "machines/m.yaml" to """
                install_with:
                  omarchy: [tmux, git]
                  brew-cask: [tpack]

                git:
                  scripts: [s]
            """.trimIndent(),
        )
        val m = ManifestLoader.loadRepo(fs(files), repo).machines.getValue("m")
        assertEquals(mapOf("tmux" to "omarchy", "git" to "omarchy", "tpack" to "brew-cask"), m.pm)
        assertEquals(listOf("s"), m.scripts)
        assertEquals(MachineGroup(install = mapOf("git" to "omarchy"), scripts = listOf("s")), m.groups["git"])
        assertEquals(setOf("tmux", "tpack", "git"), m.groups.keys)

        fun error(machine: String) = assertFailsWith<ManifestException> {
            ManifestLoader.loadRepo(fs(files + ("machines/m.yaml" to machine)), repo)
        }.message.orEmpty()
        assertTrue("machines/m.yaml: tmux is listed twice under install_with (omarchy and brew-cask)" in
            error("install_with:\n  omarchy: [tmux]\n  brew-cask: [tmux]"))
        assertTrue("machines/m.yaml: tmux is listed under install_with.omarchy and has its own install_with: omarchy" in
            error("install_with:\n  omarchy: [tmux]\ntmux:\n  install_with: omarchy"))
        assertTrue("machines/m.yaml: install_with must be a mapping of variants to programs (dnf: [curl, gcc])" in
            error("install_with: omarchy"))
        assertTrue("machines/m.yaml: install_with.omarchy is a list of strings" in error("install_with:\n  omarchy: tmux"))
    }

    @Test
    fun aMachineOverridesAProfilesListedProgram() {
        val files = mapOf(
            "loadout.yaml" to "programs:\n  git:\n    install:\n      dnf: {}\n      brew: {}",
            "profiles/p.yaml" to "install_with:\n  dnf: [git]",
            "machines/m.yaml" to "extends: [p]\n\ninstall_with:\n  brew: [git]",
        )
        assertEquals("brew", ManifestLoader.loadRepo(fs(files), repo).machines.getValue("m").pm["git"])
    }

    @Test
    fun siblingProfilesMustAgreeAndTheMachineOverridesThem() {
        val files = mapOf(
            "loadout.yaml" to """
                data:
                  omarchy: false

                scripts:
                  ssh:
                    file: ssh.sh
                programs:
                  git:
                    install:
                      dnf: {}
                      brew: {}
            """.trimIndent(),
            "ssh.sh" to "#!/bin/sh\n",
            "profiles/a.yaml" to "git:\n  install_with: dnf\n  scripts: [ssh one]\n\ndata:\n  omarchy: true",
            "profiles/b.yaml" to "git:\n  install_with: dnf\n  scripts: [ssh one]\n\ndata:\n  omarchy: true",
            "machines/m.yaml" to "extends: [a, b]\n\ngit:\n  install_with: brew",
        )
        // Equal values from two profiles are fine; the machine overrides both.
        val m = ManifestLoader.loadRepo(fs(files), repo).machines.getValue("m")
        assertEquals("brew", m.pm["git"])
        assertEquals(mapOf("ssh" to "one"), m.scriptArgs())

        val disagree = files + (
            "profiles/b.yaml" to "git:\n  install_with: brew\n  scripts: [ssh two]\n\ndata:\n  omarchy: false"
            )
        val e = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs(disagree), repo) }.message.orEmpty()
        assertTrue("machines/m.yaml: profiles 'a' and 'b' map 'git' differently ('dnf' vs 'brew')" in e, e)
        assertTrue("machines/m.yaml: profiles 'a' and 'b' opt into 'ssh' with different arguments" in e, e)
        assertTrue("machines/m.yaml: profiles 'a' and 'b' set data key 'omarchy' differently" in e, e)
    }

    @Test
    fun machineScriptOptInsAreValidated() {
        val fs = fs(
            mapOf(
                "loadout.yaml" to """
                    scripts:
                      inline:
                        run: echo hi
                """.trimIndent(),
                "machines/m.yaml" to """
                    setup:
                      scripts: [ghost, inline some-arg]
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
                "loadout.yaml" to """
                    meta:
                      min-tool-version: 999.0.0

                    programs:
                      git:
                        install:
                          dnf:
                            command: x
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
                "loadout.yaml" to """
                    meta:
                      min-tool-version: 0.1.0

                    programs:
                      git:
                        install:
                          dnf:
                            command: x
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
                "loadout.yaml" to """
                    programs:
                      git:
                        install:
                          dnf:
                            command: x
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
                "loadout.yaml" to """
                    programs:
                      ripgrep:
                        via: [dnf]
                """.trimIndent(),
                "machines/laptop.yaml" to "ripgrep:\n  install_with: dnf",
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
                "loadout.yaml" to """
                    installers:
                      dnf:
                        probe: dnf5
                        install: sudo dnf5 install -y {pkg}
                        check: rpm -q {pkg}
                        regex: '([0-9.]+)'

                    programs:
                      ripgrep:
                        via: [dnf]
                """.trimIndent(),
                "machines/laptop.yaml" to "ripgrep:\n  install_with: dnf",
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
        // parse() is test-only and deliberately laxer (inline machines,
        // no file: existence check) — but if it disagreed about INSTALLERS,
        // every engine test would be exercising a resolution production never
        // performs. Both go through withBuiltinInstallers.
        val text = """
            programs:
              ripgrep:
                via: [dnf]
        """.trimIndent()
        val parsed = ManifestLoader.parse(text)
        val loaded = ManifestLoader.loadRepo(fs(mapOf("loadout.yaml" to text)), repo)
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
                    "loadout.yaml" to "programs:\n  zsh:\n    via: [omarchy]\n  yay-only:\n    via: [omarchy-aur]",
                    "machines/t2.yaml" to "zsh:\n  install_with: omarchy\nyay-only:\n  install_with: omarchy-aur",
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
                "loadout.yaml" to """
                    templates:
                      rpm:
                        packages: [vlc]
                        install:
                          dnf:
                            command: sudo dnf install -y {name}
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
            ConfigException("x"),
        )
        for (e in ours) assertTrue(e is LoadoutException, "${e::class.simpleName} is not a LoadoutException")
    }
}
