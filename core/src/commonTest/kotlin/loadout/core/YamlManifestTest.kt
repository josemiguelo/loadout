package loadout.core

import loadout.core.engine.UpgradeEngine
import loadout.core.engine.UpgradeException
import loadout.core.manifest.ManifestException
import loadout.core.manifest.ManifestLoader
import loadout.core.model.Manifest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import okio.Path.Companion.toPath
import okio.fakefilesystem.FakeFileSystem

/** YAML manifests: one program per file, machine and profile files keyed by program. */
class YamlManifestTest {
    private val repo = "/repo".toPath()

    private val layout = """
        layout:
          fragments: [programs/**/*.yaml]
          machines: machines
          profiles: profiles
          state: state
    """.trimIndent()

    private fun load(files: Map<String, String>): Manifest {
        val fs = FakeFileSystem()
        for ((path, content) in files) {
            val full = repo / path
            full.parent?.let { fs.createDirectories(it) }
            fs.write(full) { writeUtf8(content) }
        }
        return ManifestLoader.loadRepo(fs, repo)
    }

    private val claude = """
        description: Claude Code CLI
        install:
          script:
            command: curl -fsSL https://claude.ai/install.sh | bash
        version:
          command: claude --version
          regex: '([0-9]+\.[0-9][0-9.]*)'
        scripts:
          skills-repo:
            description: link the skills repo into ~/.claude/skills
            file: skills-repo.sh
            check: file:skills-repo.sh check
    """.trimIndent()

    @Test
    fun programFileIsNamedByItsFile() {
        val manifest = load(
            mapOf(
                "loadout.yaml" to layout,
                "programs/cli/claude.yaml" to claude,
                "programs/cli/skills-repo.sh" to "#!/bin/sh\n",
            ),
        )
        val program = manifest.programs.getValue("claude")
        assertEquals("Claude Code CLI", program.description)
        assertEquals(
            "curl -fsSL https://claude.ai/install.sh | bash",
            program.install.getValue("script").command,
        )
        assertEquals("([0-9]+\\.[0-9][0-9.]*)", program.version?.regex)
    }

    @Test
    fun scriptsDefinedInProgramFileAreNamedByTheirKey() {
        val manifest = load(
            mapOf(
                "loadout.yaml" to layout,
                "programs/cli/claude.yaml" to claude,
                "programs/cli/skills-repo.sh" to "#!/bin/sh\n",
            ),
        )
        assertEquals("skills-repo.sh", manifest.scripts.getValue("skills-repo").file)
    }

    @Test
    fun machineMapsProgramsAndOptsScriptsIn() {
        val manifest = load(
            mapOf(
                "loadout.yaml" to layout,
                "programs/cli/claude.yaml" to claude,
                "programs/cli/skills-repo.sh" to "#!/bin/sh\n",
                "machines/host.yaml" to """
                    claude:
                      install_with: script
                      scripts:
                        - skills-repo
                """.trimIndent(),
            ),
        )
        val host = manifest.machines.getValue("host")
        assertEquals("script", host.pm.getValue("claude"))
        assertEquals(listOf("skills-repo"), host.scripts)
    }

    @Test
    fun machineExtendsProfileFile() {
        val manifest = load(
            mapOf(
                "loadout.yaml" to layout,
                "programs/core/curl.yaml" to "via: [dnf]\n",
                "profiles/fedora.yaml" to """
                    curl:
                      install_with: dnf
                """.trimIndent(),
                "machines/host.yaml" to """
                    extends: [fedora]
                """.trimIndent(),
            ),
        )
        assertEquals("dnf", manifest.machines.getValue("host").pm.getValue("curl"))
        assertTrue("fedora" !in manifest.machines, "a profile is not a machine")
    }

    private val claudeWithOutdated = claude + """

        outdated:
          command: file:outdated-claude.sh
          upgrade: file:outdated-claude.sh update
    """.trimIndent()

    private fun claudeRepo(
        program: String = claudeWithOutdated,
        machineFile: Pair<String, String> = "machines/host.yaml" to "claude:\n  install_with: script\n",
    ): Map<String, String> = mapOf(
        "loadout.yaml" to layout,
        "programs/cli/claude.yaml" to program,
        "programs/cli/skills-repo.sh" to "#!/bin/sh\n",
        "programs/cli/outdated-claude.sh" to "#!/bin/sh\n",
    ) + mapOf(machineFile)

    @Test
    fun programOwnedOutdatedReadsCandidateWithVersionRegex() {
        val manifest = load(claudeRepo())
        val check = manifest.resolveInstall("claude", "script").outdated
        assertEquals("file:outdated-claude.sh", check?.command)
        assertEquals("([0-9]+\\.[0-9][0-9.]*)", check?.regex)
        assertEquals("programs/cli", check?.origin)
    }

    @Test
    fun programOwnedOutdatedNeedsAVersionRegex() {
        val error = assertFailsWith<ManifestException> {
            load(
                claudeRepo(
                    program = "description: Claude\n" +
                        "install:\n  script:\n    command: echo hi\n" +
                        "outdated:\n  command: file:outdated-claude.sh\n",
                ),
            )
        }
        assertTrue("version with a regex" in error.message.orEmpty(), error.message)
    }

    @Test
    fun programOwnedUpgradeRunsForAMappedProgram() {
        val manifest = load(claudeRepo())
        val steps = UpgradeEngine.planPrograms(manifest, "host", listOf("claude"))
        assertEquals(1, steps.size)
        assertEquals("sh 'outdated-claude.sh' update", steps.single().command)
        assertEquals(listOf("claude"), steps.single().covers)
        assertEquals("programs/cli", steps.single().origin)
    }

    @Test
    fun programOwnedUpgradeRefusesAnUnmappedProgram() {
        val manifest = load(claudeRepo(machineFile = "machines/other.yaml" to "# maps nothing\n"))
        assertFailsWith<UpgradeException> {
            UpgradeEngine.planPrograms(manifest, "other", listOf("claude"))
        }
    }

    private val rootYaml = """
        layout:
          fragments:
            - programs/**/*.yaml
            - configs/**/.loadout.yaml
          machines: machines
          profiles: profiles
          state: state
        data:
          work: false
    """.trimIndent()

    @Test
    fun rootFileIsYamlAndCarriesDataAndLayout() {
        val manifest = load(mapOf("loadout.yaml" to rootYaml))
        assertEquals("false", manifest.data.getValue("work").toString())
    }

    @Test
    fun fragmentHoldsInstallersProgramsScriptsAndOutdatedSources() {
        val manifest = load(
            mapOf(
                "loadout.yaml" to rootYaml,
                "configs/tmux/.loadout.yaml" to """
                    installers:
                      mytool:
                        install: echo install {pkg}
                        check: echo mytool 1.0
                        regex: '([0-9]+\.[0-9]+)'
                    programs:
                      tmux:
                        via: [mytool]
                    scripts:
                      tmux-plugins:
                        file: plugins.sh
                    outdated:
                      tmux-plugins:
                        command: file:plugins.sh outdated
                        upgrade: file:plugins.sh update {item}
                """.trimIndent(),
                "configs/tmux/plugins.sh" to "#!/bin/sh\n",
                "machines/host.yaml" to "tmux:\n  install_with: mytool\n",
            ),
        )
        assertTrue("mytool" in manifest.installers)
        assertEquals("mytool", manifest.programs.getValue("tmux").install.keys.single())
        assertEquals("plugins.sh", manifest.scripts.getValue("tmux-plugins").file)
        assertEquals("file:plugins.sh outdated", manifest.outdated.getValue("tmux-plugins").command)
        assertEquals("mytool", manifest.machines.getValue("host").pm.getValue("tmux"))
    }

    @Test
    fun fragmentRejectsAnUnknownSection() {
        val error = assertFailsWith<ManifestException> {
            load(
                mapOf(
                    "loadout.yaml" to rootYaml,
                    "configs/tmux/.loadout.yaml" to "machines:\n  host: {}\n",
                ),
            )
        }
        assertTrue("unknown section 'machines'" in error.message.orEmpty(), error.message)
    }

    @Test
    fun aKeyWithNothingUnderItIsAnEmptyTable() {
        val manifest = load(
            mapOf(
                "loadout.yaml" to layout,
                "programs/core/zlib-devel.yaml" to "via: [dnf]\ninstall:\n  dnf:\n",
            ),
        )
        assertEquals("dnf", manifest.programs.getValue("zlib-devel").install.keys.single())
    }

    @Test
    fun aMachineEntryWithNothingUnderItIsAnError() {
        val error = assertFailsWith<ManifestException> {
            load(
                mapOf(
                    "loadout.yaml" to layout,
                    "programs/core/curl.yaml" to "via: [dnf]\n",
                    "machines/host.yaml" to "curl:\n",
                ),
            )
        }
        assertTrue("curl has nothing under it" in error.message.orEmpty(), error.message)
    }
}
