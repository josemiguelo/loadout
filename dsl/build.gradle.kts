plugins {
    alias(libs.plugins.kotlin.multiplatform)
    `maven-publish`
}

// The Kotlin DSL config repos write their manifests in. Multiplatform so
// core's (native) tests build their fixtures with it too; `loadout
// compile` runs it on the JVM (jvmMain's Compile).
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
        commonMain.dependencies {
            api(project(":model"))
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
