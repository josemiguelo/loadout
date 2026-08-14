package io.github.josemiguelo.postinstaller.core

import io.github.josemiguelo.postinstaller.core.manifest.ManifestException
import io.github.josemiguelo.postinstaller.core.manifest.ManifestLoader
import io.github.josemiguelo.postinstaller.core.model.PackageManager
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

val EXAMPLE_MANIFEST = """
    [meta]
    name = "example machines"
    min-tool-version = "0.1.0"

    [programs.git]
    description = "version control"

    [programs.git.version]
    command = "git --version"
    regex = "git version ([0-9.]+)"

    [programs.git.install]
    brew = "brew install git"
    dnf = "sudo dnf install -y git"
    apt = "sudo apt-get install -y git"

    [programs.ripgrep]
    description = "fast grep"
    tags = ["cli"]
    depends-on = ["git"]

    [programs.ripgrep.version]
    command = "rg --version"
    regex = "ripgrep ([0-9][0-9a-zA-Z.-]*)"

    [programs.ripgrep.install]
    brew = "brew install ripgrep"
    dnf = "sudo dnf install -y ripgrep"

    [programs.rustup]
    description = "rust toolchain manager"

    [programs.rustup.version]
    command = "rustup --version"
    regex = "rustup ([0-9.]+)"

    [programs.rustup.install]
    script = "curl -sSf https://sh.rustup.rs | sh -s -- -y"

    [scripts.dotfiles]
    description = "clone and link dotfiles"
    run = "scripts/dotfiles.sh"
    os = ["linux", "macos"]
    check = "test -d ${'$'}HOME/.dotfiles"
    after = ["programs.git"]
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
        assertEquals("brew install ripgrep", ripgrep.install["brew"])
        assertEquals("sudo dnf install -y ripgrep", ripgrep.installCommandFor(PackageManager.DNF))
        assertNull(ripgrep.installCommandFor(PackageManager.PACMAN))

        val rustup = manifest.programs.getValue("rustup")
        assertEquals("curl -sSf https://sh.rustup.rs | sh -s -- -y", rustup.installCommandFor(PackageManager.PACMAN))

        val dotfiles = manifest.scripts.getValue("dotfiles")
        assertEquals("scripts/dotfiles.sh", dotfiles.run)
        assertEquals(listOf("programs.git"), dotfiles.after)
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
            run = "x.sh"
            after = ["programs.ghost"]
        """.trimIndent()
        val e = assertFailsWith<ManifestException> { ManifestLoader.parse(text) }
        assertTrue("unknown step 'programs.ghost'" in e.message.orEmpty())
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
