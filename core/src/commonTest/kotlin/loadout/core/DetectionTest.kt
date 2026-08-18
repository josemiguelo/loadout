package loadout.core

import loadout.core.detect.Detection
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import okio.Path.Companion.toPath
import okio.fakefilesystem.FakeFileSystem

class DetectionTest {
    @Test
    fun parsesDistroFromOsRelease() {
        val fs = FakeFileSystem()
        fs.createDirectories("/etc".toPath())
        fs.write("/etc/os-release".toPath()) {
            writeUtf8(
                """
                NAME="Fedora Linux"
                VERSION="44 (Workstation Edition)"
                ID=fedora
                VERSION_ID=44
                """.trimIndent(),
            )
        }
        val detection = Detection(FakeProcessRunner(), fs)
        assertEquals("fedora", detection.detectDistro())
    }

    @Test
    fun parsesQuotedDistroId() {
        val fs = FakeFileSystem()
        fs.createDirectories("/etc".toPath())
        fs.write("/etc/os-release".toPath()) { writeUtf8("ID=\"opensuse-leap\"\n") }
        val detection = Detection(FakeProcessRunner(), fs)
        assertEquals("opensuse-leap", detection.detectDistro())
    }

    @Test
    fun missingOsReleaseGivesNullDistro() {
        val detection = Detection(FakeProcessRunner(), FakeFileSystem())
        assertNull(detection.detectDistro())
    }

    @Test
    fun binaryAvailabilityProbesViaCommandV() {
        val runner = FakeProcessRunner()
        runner.onCommand("command -v dnf", stdout = "/usr/bin/dnf")

        val detection = Detection(runner, FakeFileSystem())
        assertTrue(detection.isBinaryAvailable("dnf"))
        assertFalse(detection.isBinaryAvailable("pacman"))
    }
}
