package io.github.josemiguelo.postinstaller.core

import io.github.josemiguelo.postinstaller.core.detect.Detection
import io.github.josemiguelo.postinstaller.core.model.PackageManager
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
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
    fun probesPackageManagersInPriorityOrder() {
        val runner = FakeProcessRunner()
        runner.onCommand("command -v dnf", stdout = "/usr/bin/dnf")
        runner.onCommand("command -v apt-get", stdout = "/usr/bin/apt-get")

        val detection = Detection(runner, FakeFileSystem())
        // brew is probed first but not present; dnf wins over apt.
        assertEquals(PackageManager.DNF, detection.detectPackageManager())
        assertEquals("command -v brew", runner.executed.first())
    }

    @Test
    fun noPackageManagerFound() {
        val detection = Detection(FakeProcessRunner(), FakeFileSystem())
        assertNull(detection.detectPackageManager())
    }
}
