package loadout.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import loadout.core.manifest.ManifestException
import loadout.core.manifest.ManifestLoader

class TemplateTest {
    private val rpmTemplate = """
        [templates.rpm]
        packages = ["vlc", "okular", "konsole"]

        [templates.rpm.version]
        command = "{name} --version 2>/dev/null || rpm -q {name}"
        regex = "([0-9]+\\.[0-9][0-9.]*)"

        [templates.rpm.install.dnf]
        command = "sudo dnf install -y {name}"

        [templates.rpm.overrides.konsole]
        description = "KDE terminal emulator"
    """.trimIndent()

    @Test
    fun packagesListExpandsToFullPrograms() {
        val manifest = ManifestLoader.parse(rpmTemplate)
        assertEquals(setOf("vlc", "okular", "konsole"), manifest.programs.keys)

        val vlc = manifest.programs.getValue("vlc")
        assertEquals("vlc --version 2>/dev/null || rpm -q vlc", vlc.version?.command)
        assertEquals("sudo dnf install -y vlc", manifest.resolveInstall("vlc", "dnf").command)
        assertNull(vlc.template)

        assertEquals("KDE terminal emulator", manifest.programs.getValue("konsole").description)
        assertEquals("sudo dnf install -y konsole", manifest.resolveInstall("konsole", "dnf").command)
    }

    @Test
    fun programsCanReferenceTemplatesByName() {
        val manifest = ManifestLoader.parse(
            """
            [templates.rpm.version]
            command = "rpm -q {name}"
            regex = "([0-9.]+)"

            [templates.rpm.install.dnf]
            command = "sudo dnf install -y {name}"

            [programs.solaar]
            template = "rpm"
            description = "Logitech device manager"

            [programs.solaar.install.brew]
            command = "brew install solaar"
            """.trimIndent(),
        )
        val solaar = manifest.programs.getValue("solaar")
        assertEquals("rpm -q solaar", solaar.version?.command)
        assertEquals("Logitech device manager", solaar.description)
        // Install tables merge per key: template's dnf + the program's own brew.
        assertEquals("sudo dnf install -y solaar", manifest.resolveInstall("solaar", "dnf").command)
        assertEquals("brew install solaar", manifest.resolveInstall("solaar", "brew").command)
    }

    @Test
    fun overrideVersionReplacesTemplateVersion() {
        val manifest = ManifestLoader.parse(
            """
            [templates.rpm]
            packages = ["weird"]

            [templates.rpm.version]
            command = "rpm -q {name}"
            regex = "([0-9.]+)"

            [templates.rpm.install.dnf]
            command = "sudo dnf install -y {name}"

            [templates.rpm.overrides.weird.version]
            command = "rpm -q --whatprovides '{name}(feature)'"
            regex = "([0-9]+)"
            """.trimIndent(),
        )
        assertEquals(
            "rpm -q --whatprovides 'weird(feature)'",
            manifest.programs.getValue("weird").version?.command,
        )
    }

    @Test
    fun templateViaExpandsThroughInstallers() {
        val manifest = ManifestLoader.parse(
            """
            [installers.dnf]
            probe = "dnf"
            install = "sudo dnf install -y {pkg}"
            check = "rpm -q {pkg}"
            regex = "([0-9.]+)"

            [templates.pkg]
            via = ["dnf"]
            packages = ["vlc"]

            [templates.pkg.overrides.vlc.install.dnf]
            check = "rpm -q --whatprovides vlc"
            """.trimIndent(),
        )
        // The override's variant replaces via's for that key, but {pkg}
        // defaulting to the program name keeps the installer's install pattern.
        val resolved = manifest.resolveInstall("vlc", "dnf")
        assertEquals("sudo dnf install -y vlc", resolved.command)
        assertEquals("rpm -q --whatprovides vlc", resolved.check?.command)
        assertEquals("dnf", resolved.probe)
    }

    @Test
    fun unknownTemplateReferenceFails() {
        val e = assertFailsWith<ManifestException> {
            ManifestLoader.parse("[programs.x]\ntemplate = \"ghost\"")
        }
        assertTrue("unknown template 'ghost'" in e.message.orEmpty())
    }

    @Test
    fun overrideForNonMemberFails() {
        val e = assertFailsWith<ManifestException> {
            ManifestLoader.parse(
                """
                [templates.rpm]
                packages = ["a"]

                [templates.rpm.install.dnf]
                command = "sudo dnf install -y {name}"

                [templates.rpm.overrides.b]
                description = "not a member"
                """.trimIndent(),
            )
        }
        assertTrue("overrides.b is not in its packages list" in e.message.orEmpty())
    }

    @Test
    fun templatePackageCollidingWithExplicitProgramFails() {
        val e = assertFailsWith<ManifestException> {
            ManifestLoader.parse(
                """
                [templates.rpm]
                packages = ["vlc"]

                [templates.rpm.install.dnf]
                command = "sudo dnf install -y {name}"

                [programs.vlc]
                [programs.vlc.install.dnf]
                command = "sudo dnf install -y vlc"
                """.trimIndent(),
            )
        }
        assertTrue("duplicate program 'vlc'" in e.message.orEmpty())
    }

    @Test
    fun expandedProgramsValidateLikeHandWrittenOnes() {
        // Machine mapping to a key the template doesn't provide still errors.
        val e = assertFailsWith<ManifestException> {
            ManifestLoader.parse(
                """
                [templates.rpm]
                packages = ["vlc"]

                [templates.rpm.install.dnf]
                command = "sudo dnf install -y {name}"

                [machines.m.pm]
                vlc = "brew"
                """.trimIndent(),
            )
        }
        assertTrue("no 'brew' entry" in e.message.orEmpty())
    }
}
