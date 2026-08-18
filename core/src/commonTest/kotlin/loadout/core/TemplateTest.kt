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

        [templates.rpm.install]
        dnf = "sudo dnf install -y {name}"

        [templates.rpm.overrides.konsole]
        description = "KDE terminal emulator"
    """.trimIndent()

    @Test
    fun packagesListExpandsToFullPrograms() {
        val manifest = ManifestLoader.parse(rpmTemplate)
        assertEquals(setOf("vlc", "okular", "konsole"), manifest.programs.keys)

        val vlc = manifest.programs.getValue("vlc")
        assertEquals("vlc --version 2>/dev/null || rpm -q vlc", vlc.version?.command)
        assertEquals("sudo dnf install -y vlc", vlc.install["dnf"])
        assertNull(vlc.template)

        assertEquals("KDE terminal emulator", manifest.programs.getValue("konsole").description)
        assertEquals("sudo dnf install -y konsole", manifest.programs.getValue("konsole").install["dnf"])
    }

    @Test
    fun programsCanReferenceTemplatesByName() {
        val manifest = ManifestLoader.parse(
            """
            [templates.rpm.version]
            command = "rpm -q {name}"
            regex = "([0-9.]+)"

            [templates.rpm.install]
            dnf = "sudo dnf install -y {name}"

            [programs.solaar]
            template = "rpm"
            description = "Logitech device manager"

            [programs.solaar.install]
            brew = "brew install solaar"
            """.trimIndent(),
        )
        val solaar = manifest.programs.getValue("solaar")
        assertEquals("rpm -q solaar", solaar.version?.command)
        assertEquals("Logitech device manager", solaar.description)
        // Install tables merge per key: template's dnf + the program's own brew.
        assertEquals("sudo dnf install -y solaar", solaar.install["dnf"])
        assertEquals("brew install solaar", solaar.install["brew"])
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

            [templates.rpm.install]
            dnf = "sudo dnf install -y {name}"

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

                [templates.rpm.install]
                dnf = "sudo dnf install -y {name}"

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

                [templates.rpm.install]
                dnf = "sudo dnf install -y {name}"

                [programs.vlc]
                [programs.vlc.install]
                dnf = "sudo dnf install -y vlc"
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

                [templates.rpm.install]
                dnf = "sudo dnf install -y {name}"

                [machines.m.pm]
                vlc = "brew"
                """.trimIndent(),
            )
        }
        assertTrue("no 'brew' entry" in e.message.orEmpty())
    }
}
