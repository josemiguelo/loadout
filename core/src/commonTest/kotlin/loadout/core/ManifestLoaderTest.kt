package loadout.core

import loadout.core.manifest.ManifestException
import loadout.core.manifest.ManifestLoader
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

val EXAMPLE_MANIFEST = """
    [meta]
    name = "example machines"
    min-tool-version = "0.1.0"

    [installers.brew]
    probe = "brew"
    install = "brew install {pkg}"

    [installers.dnf]
    probe = "dnf"
    install = "sudo dnf install -y {pkg}"

    [installers.apt]
    probe = "apt-get"
    install = "sudo apt-get install -y {pkg}"

    [programs.git]
    description = "version control"
    via = ["brew", "dnf", "apt"]

    [programs.git.version]
    command = "git --version"
    regex = "git version ([0-9.]+)"

    [programs.ripgrep]
    description = "fast grep"
    tags = ["cli"]
    depends-on = ["git"]
    via = ["brew", "dnf"]

    [programs.ripgrep.version]
    command = "rg --version"
    regex = "ripgrep ([0-9][0-9a-zA-Z.-]*)"

    [programs.rustup]
    description = "rust toolchain manager"

    [programs.rustup.version]
    command = "rustup --version"
    regex = "rustup ([0-9.]+)"

    [programs.rustup.install.script]
    command = "curl -sSf https://sh.rustup.rs | sh -s -- -y"

    [scripts.dotfiles]
    description = "clone and link dotfiles"
    file = "scripts/dotfiles.sh"
    os = ["linux", "macos"]
    check = "test -d ${'$'}HOME/.dotfiles"
    after = ["programs.git"]

    [machines.laptop.pm]
    git = "dnf"
    ripgrep = "dnf"
    rustup = "script"

    [machines.macbook.pm]
    git = "brew"
    ripgrep = "brew"
    rustup = "script"
""".trimIndent()

class ManifestLoaderTest {
    @Test
    fun parsesExampleManifest() {
        val manifest = ManifestLoader.parse(EXAMPLE_MANIFEST)

        assertEquals("example machines", manifest.meta.name)
        assertEquals("0.1.0", manifest.meta.minToolVersion)
        assertEquals(setOf("git", "ripgrep", "rustup"), manifest.programs.keys)

        val ripgrep = manifest.programs.getValue("ripgrep")
        assertEquals(listOf("git"), ripgrep.dependsOn)
        assertEquals("rg --version", ripgrep.version?.command)
        // via expands to installer-backed variants; resolution applies patterns.
        assertEquals("brew install ripgrep", manifest.resolveInstall("ripgrep", "brew").command)
        assertEquals("sudo dnf install -y ripgrep", manifest.resolveInstall("ripgrep", "dnf").command)
        assertEquals("dnf", manifest.resolveInstall("ripgrep", "dnf").probe)
        assertNull(ripgrep.install["pacman"])

        val dotfiles = manifest.scripts.getValue("dotfiles")
        assertEquals("scripts/dotfiles.sh", dotfiles.file)
        assertEquals(listOf("programs.git"), dotfiles.after)

        assertEquals("dnf", manifest.machines.getValue("laptop").pm["ripgrep"])
        assertEquals("script", manifest.machines.getValue("macbook").pm["rustup"])
    }

    @Test
    fun rejectsUnknownDependency() {
        val text = """
            [programs.a]
            depends-on = ["nope"]
        """.trimIndent()
        val e = assertFailsWith<ManifestException> { ManifestLoader.parse(text) }
        assertTrue("unknown program 'nope'" in e.message.orEmpty())
    }

    @Test
    fun rejectsDependencyCycle() {
        val text = """
            [programs.a]
            depends-on = ["b"]

            [programs.b]
            depends-on = ["a"]
        """.trimIndent()
        val e = assertFailsWith<ManifestException> { ManifestLoader.parse(text) }
        assertTrue("cycle" in e.message.orEmpty())
    }

    @Test
    fun rejectsUnknownAfterReference() {
        val text = """
            [scripts.s]
            run = "echo x"
            after = ["programs.ghost"]
        """.trimIndent()
        val e = assertFailsWith<ManifestException> { ManifestLoader.parse(text) }
        assertTrue("unknown step 'programs.ghost'" in e.message.orEmpty())
    }

    @Test
    fun rejectsScriptWithBothFileAndRun() {
        val text = """
            [scripts.s]
            file = "x.sh"
            run = "echo x"
        """.trimIndent()
        val e = assertFailsWith<ManifestException> { ManifestLoader.parse(text) }
        assertTrue("exactly one of 'file'" in e.message.orEmpty())
    }

    @Test
    fun rejectsScriptWithNeitherFileNorRun() {
        val text = """
            [scripts.s]
            description = "does nothing"
        """.trimIndent()
        val e = assertFailsWith<ManifestException> { ManifestLoader.parse(text) }
        assertTrue("exactly one of 'file'" in e.message.orEmpty())
    }

    @Test
    fun rejectsMachineMappingToUnknownProgram() {
        val text = """
            [programs.a]
            [programs.a.install.dnf]
            command = "sudo dnf install -y a"

            [machines.m.pm]
            ghost = "dnf"
        """.trimIndent()
        val e = assertFailsWith<ManifestException> { ManifestLoader.parse(text) }
        assertTrue("unknown program 'ghost'" in e.message.orEmpty())
    }

    @Test
    fun rejectsMachineMappingToMissingInstallKey() {
        val text = """
            [programs.a]
            [programs.a.install.dnf]
            command = "sudo dnf install -y a"

            [machines.m.pm]
            a = "brew"
        """.trimIndent()
        val e = assertFailsWith<ManifestException> { ManifestLoader.parse(text) }
        assertTrue("no 'brew' entry" in e.message.orEmpty())
    }

    @Test
    fun installerResolutionAppliesPkgAndOverrides() {
        val manifest = ManifestLoader.parse(
            """
            [installers.brew-cask]
            probe = "brew"
            install = "brew install --cask {pkg}"
            check = "brew list --cask --versions {pkg}"
            regex = "([0-9.]+)"

            [programs.toolbox.install.brew-linux]
            installer = "brew-cask"
            pkg = "toolbox-linux"
            command = "brew tap x/y && brew install --cask toolbox-linux"

            [programs.toolbox.install.brew-macos]
            installer = "brew-cask"
            """.trimIndent(),
        )
        val linux = manifest.resolveInstall("toolbox", "brew-linux")
        assertEquals("brew tap x/y && brew install --cask toolbox-linux", linux.command)
        assertEquals("brew list --cask --versions toolbox-linux", linux.check?.command)
        assertEquals("brew", linux.probe)

        val macos = manifest.resolveInstall("toolbox", "brew-macos")
        assertEquals("brew install --cask toolbox", macos.command)
        assertEquals("brew list --cask --versions toolbox", macos.check?.command)
    }

    @Test
    fun variantCheckOverridesInstallerCheckKeepingItsRegex() {
        val manifest = ManifestLoader.parse(
            """
            [installers.dnf]
            probe = "dnf"
            install = "sudo dnf install -y {pkg}"
            check = "rpm -q {pkg}"
            regex = "([0-9.]+)"

            [programs.zlib-devel.install.dnf]
            check = "rpm -q --whatprovides zlib-devel"
            """.trimIndent(),
        )
        val resolved = manifest.resolveInstall("zlib-devel", "dnf")
        assertEquals("sudo dnf install -y zlib-devel", resolved.command)
        assertEquals("rpm -q --whatprovides zlib-devel", resolved.check?.command)
        assertEquals("([0-9.]+)", resolved.check?.regex)
    }

    @Test
    fun rejectsUnknownInstallerReferences() {
        val viaError = assertFailsWith<ManifestException> {
            ManifestLoader.parse("[programs.a]\nvia = [\"ghost\"]")
        }
        assertTrue("via references unknown installer 'ghost'" in viaError.message.orEmpty())

        val refError = assertFailsWith<ManifestException> {
            ManifestLoader.parse(
                """
                [programs.b.install.dnf]
                installer = "phantom"
                """.trimIndent(),
            )
        }
        assertTrue("unknown installer 'phantom'" in refError.message.orEmpty())
    }

    @Test
    fun rejectsVariantResolvingToNoCommand() {
        val e = assertFailsWith<ManifestException> {
            ManifestLoader.parse(
                """
                [installers.checker-only]
                check = "which {pkg}"
                regex = "(.+)"

                [programs.a.install.checker-only]
                """.trimIndent(),
            )
        }
        assertTrue("resolves to no install command" in e.message.orEmpty())
    }

    @Test
    fun rejectsCheckWithoutRegex() {
        val e = assertFailsWith<ManifestException> {
            ManifestLoader.parse(
                """
                [installers.bad]
                install = "install {pkg}"
                check = "query {pkg}"
                """.trimIndent(),
            )
        }
        assertTrue("installers.bad has a check but no regex" in e.message.orEmpty())

        val e2 = assertFailsWith<ManifestException> {
            ManifestLoader.parse(
                """
                [programs.a.install.manual]
                command = "true"
                check = "query a"
                """.trimIndent(),
            )
        }
        assertTrue("install.manual has a check but no regex" in e2.message.orEmpty())
    }

    @Test
    fun explicitVariantWinsOverViaForTheSameKey() {
        val manifest = ManifestLoader.parse(
            """
            [installers.dnf]
            probe = "dnf"
            install = "sudo dnf install -y {pkg}"

            [programs.a]
            via = ["dnf"]

            [programs.a.install.dnf]
            command = "sudo dnf install -y a-special"
            """.trimIndent(),
        )
        // The explicit table refines via's entry — and still resolves through
        // the installer its key names (probe kept).
        val resolved = manifest.resolveInstall("a", "dnf")
        assertEquals("sudo dnf install -y a-special", resolved.command)
        assertEquals("dnf", resolved.probe)
    }

    @Test
    fun installOrderPutsDependenciesFirst() {
        val manifest = ManifestLoader.parse(EXAMPLE_MANIFEST)
        val order = ManifestLoader.installOrder(manifest, listOf("ripgrep"))
        assertEquals(listOf("git", "ripgrep"), order)

        val all = ManifestLoader.installOrder(manifest)
        assertTrue(all.indexOf("git") < all.indexOf("ripgrep"))
        assertEquals(setOf("git", "ripgrep", "rustup"), all.toSet())
    }
}
