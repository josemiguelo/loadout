plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    // Test binaries only link here; see app/build.gradle.kts for why.
    listOf(linuxX64(), linuxArm64()).forEach { target ->
        target.binaries.all { linkerOpts("-Wl,--as-needed") }
    }
    macosX64()
    macosArm64()

    // Ctrl-C during a home-screen hand-off: a C signal handler, since a
    // Kotlin one isn't async-signal-safe (see the .def).
    targets.withType<org.jetbrains.kotlin.gradle.plugin.mpp.KotlinNativeTarget>().configureEach {
        compilations.getByName("main").cinterops.create("signals") {
            definitionFile.set(project.file("src/nativeInterop/cinterop/signals.def"))
        }
    }

    applyDefaultHierarchyTemplate()

    sourceSets {
        commonMain.dependencies {
            implementation(libs.coroutines.core)
            implementation(libs.serialization.json)
            implementation(libs.datetime)
            implementation(libs.okio)
            implementation(libs.kaml)
            implementation(libs.kommand)
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation(libs.okio.fakefilesystem)
            implementation(libs.coroutines.test)
        }
    }
}
