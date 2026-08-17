package io.github.josemiguelo.postinstaller.core

import io.github.josemiguelo.postinstaller.core.detect.Detection
import io.github.josemiguelo.postinstaller.core.model.PackageManager
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
    fun pmAvailabilityProbesTheRightBinary() {
        val runner = FakeProcessRunner()
        runner.onCommand("command -v dnf", stdout = "/usr/bin/dnf")
        runner.onCommand("command -v apt-get", stdout = "/usr/bin/apt-get")

        val detection = Detection(runner, FakeFileSystem())
        assertTrue(detection.isPmAvailable(PackageManager.DNF))
        // apt probes apt-get, not apt.
        assertTrue(detection.isPmAvailable(PackageManager.APT))
        assertFalse(detection.isPmAvailable(PackageManager.PACMAN))
    }
}
