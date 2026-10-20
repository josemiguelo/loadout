plugins {
    alias(libs.plugins.kotlin.multiplatform)
    `maven-publish`
    alias(libs.plugins.kotlin.serialization)
}

// The manifest model, its validation and the lock file: what the native
// binary reads and the JVM DSL writes, so both share one model and one set
// of error messages.
kotlin {
    // JVM 17: what a config repo's Gradle may run on.
    jvm {
        compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
    }
    // Test binaries link here: Kotlin/Native's posix klib links -lcrypt,
    // which --as-needed drops (see app/build.gradle.kts).
    listOf(linuxX64(), linuxArm64()).forEach { target ->
        target.binaries.all { linkerOpts("-Wl,--as-needed") }
    }
    macosX64()
    macosArm64()

    applyDefaultHierarchyTemplate()

    sourceSets {
        // Both are in the model's API: data is a JsonObject, Glob and the
        // lock take okio paths.
        commonMain.dependencies {
            api(libs.serialization.json)
            api(libs.okio)
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation(libs.okio.fakefilesystem)
        }
    }
}

// The share directory's maven repo (root `bundle` task).
publishing {
    repositories {
        maven {
            name = "bundle"
            url = uri(rootProject.layout.buildDirectory.dir("bundle/maven"))
        }
    }
}
