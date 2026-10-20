plugins {
    alias(libs.plugins.kotlin.multiplatform) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.compose.compiler) apply false
}

// The DSL, the model under it and the Gradle plugin are published under one
// group at loadout's own version; a config repo compiles against exactly
// the binary's.
allprojects {
    group = "io.github.josemiguelo.loadout"
}

/** Where `bundle` puts the share directory install.sh installs beside the binary. */
val bundleDir = layout.buildDirectory.dir("bundle")

/**
 * loadout's share directory, as the release tarballs carry it: `maven/` (the
 * DSL and the Gradle plugin, JVM only), `gradle/` (the wrapper `loadout
 * init` gives a new repo) and `VERSION`. Tests point LOADOUT_HOME here.
 */
val bundle by tasks.registering(Copy::class) {
    dependsOn(
        ":model:publishKotlinMultiplatformPublicationToBundleRepository",
        ":model:publishJvmPublicationToBundleRepository",
        ":dsl:publishKotlinMultiplatformPublicationToBundleRepository",
        ":dsl:publishJvmPublicationToBundleRepository",
        ":gradle-plugin:publishAllPublicationsToBundleRepository",
    )
    from(".") {
        include("gradlew", "gradle/wrapper/gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.properties")
    }
    into(bundleDir.map { it.dir("gradle") })
    val version = project.version.toString()
    // An input, so a version bump rewrites VERSION (the copy alone would be up to date).
    inputs.property("version", version)
    doLast {
        bundleDir.get().file("VERSION").asFile.writeText(version + "\n")
    }
}

/** gradle.properties' version and the binary's TOOL_VERSION must agree. */
val checkVersion by tasks.registering {
    val source = file("model/src/commonMain/kotlin/loadout/core/Version.kt")
    val expected = project.version.toString()
    inputs.file(source)
    doLast {
        val actual = Regex("""TOOL_VERSION: String = "([^"]+)"""").find(source.readText())?.groupValues?.get(1)
        check(actual == expected) { "TOOL_VERSION is $actual but gradle.properties says $expected" }
    }
}
