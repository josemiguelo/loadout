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

    applyDefaultHierarchyTemplate()

    sourceSets {
        commonMain.dependencies {
            implementation(libs.coroutines.core)
            implementation(libs.serialization.json)
            implementation(libs.datetime)
            implementation(libs.okio)
            implementation(libs.ktoml.core)
            implementation(libs.kommand)
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation(libs.okio.fakefilesystem)
            implementation(libs.coroutines.test)
        }
    }
}
