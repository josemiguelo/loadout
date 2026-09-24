import org.jetbrains.kotlin.gradle.plugin.mpp.DisableCacheInKotlinVersion
import org.jetbrains.kotlin.gradle.plugin.mpp.KotlinNativeCacheApi

plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.compose.compiler)
}

kotlin {
    listOf(
        linuxX64(),
        linuxArm64(),
        macosX64(),
        macosArm64(),
    ).forEach { target ->
        target.binaries.executable {
            baseName = "loadout"
            entryPoint = "loadout.main"
        }
        // Applies to the run and test binaries alike.
        target.binaries.all {
            // Kotlin/Native's platform.posix klib links -lcrypt, which its
            // glibc-2.19 sysroot resolves to libcrypt.so.1 — shipped only by a
            // compat package on Arch and current Fedora. Nothing here calls
            // crypt(), so --as-needed drops the dependency (core does the same).
            if (target.name.startsWith("linux")) linkerOpts("-Wl,--as-needed")
            @OptIn(KotlinNativeCacheApi::class)
            disableNativeCache(
                DisableCacheInKotlinVersion.`2_4_0`,
                "clikt 5.1.0 ships clikt and clikt-mordant klibs that both define " +
                    "Context.selfAndAncestors; per-library native caches make ld.lld " +
                    "fail with a duplicate-symbol error.",
            )
        }
    }

    applyDefaultHierarchyTemplate()

    sourceSets {
        commonMain.dependencies {
            implementation(project(":core"))
            implementation(libs.clikt)
            implementation(libs.mosaic.runtime)
            implementation(libs.mosaic.terminal)
            implementation(libs.mosaic.tty)
            implementation(libs.mosaic.tty.terminal)
            implementation(libs.coroutines.core)
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
        }
    }
}
