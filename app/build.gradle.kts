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
            baseName = "post-installer"
            entryPoint = "io.github.josemiguelo.postinstaller.main"
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
            implementation(libs.coroutines.core)
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
        }
    }
}
