package loadout.gradle

import loadout.core.manifest.Glob
import okio.FileSystem
import okio.Path.Companion.toOkioPath
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.tasks.JavaExec
import org.gradle.api.tasks.SourceSetContainer
import org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension
import java.io.File
import java.security.MessageDigest

/** `loadout { sources(…) }`: the manifest globs, in compile order. */
open class LoadoutExtension {
    internal val sources = mutableListOf<String>()

    fun sources(vararg globs: String) {
        sources += globs
    }
}

/**
 * A config repo as a Gradle project. Applies Kotlin/JVM over exactly the
 * files `loadout { sources(…) }` matches (loadout's own glob rules, so the
 * compiled set is the hashed set), puts the DSL on the classpath at this
 * plugin's version, and registers `loadoutCompile`, which runs the
 * manifests and writes loadout.lock.json. Builds outside the repo (see
 * [buildDirFor]).
 */
class LoadoutPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        val version = LoadoutPlugin::class.java.`package`.implementationVersion
            ?: error("the loadout plugin's jar has no version")
        val home = System.getenv("LOADOUT_HOME") ?: "${System.getProperty("user.home")}/.local/share/loadout"
        val extension = project.extensions.create("loadout", LoadoutExtension::class.java)

        // Before the build script runs, so a repo that sets its own still wins.
        project.layout.buildDirectory.set(buildDirFor(project))
        project.pluginManager.apply("org.jetbrains.kotlin.jvm")
        project.repositories.maven { it.setUrl(project.uri("$home/maven")) }
        project.repositories.mavenCentral()
        project.dependencies.add("implementation", "io.github.josemiguelo.loadout:dsl:$version")

        project.afterEvaluate {
            val root = project.projectDir.toOkioPath()
            val files = extension.sources
                .flatMap { Glob.expand(FileSystem.SYSTEM, root, it) }
                .map { Glob.relative(root, it) }
                .distinct()
            val kotlin = project.extensions.getByType(KotlinJvmProjectExtension::class.java)
            kotlin.sourceSets.getByName("main").kotlin.apply {
                setSrcDirs(listOf(project.projectDir))
                setIncludes(files.ifEmpty { listOf("<no manifests>") })
            }
        }

        project.tasks.register("loadoutCompile", JavaExec::class.java) { task ->
            task.group = "loadout"
            task.description = "Compiles the manifests into loadout.lock.json."
            val main = project.extensions.getByType(SourceSetContainer::class.java).getByName("main")
            task.dependsOn("classes")
            task.classpath = main.runtimeClasspath
            task.mainClass.set("loadout.dsl.CompileKt")
            task.argumentProviders.add {
                listOf(project.projectDir.path) + main.output.classesDirs.files.map { it.path } + "--" + extension.sources
            }
        }
    }
}

/**
 * `${XDG_CACHE_HOME:-~/.cache}/loadout/build/<folder>-<hash of its path>`:
 * one per checkout, worktrees included. The source root is the repo itself
 * (narrowed by includes), and an editor's Gradle import (kotlin-lsp's)
 * drops the includes: compiled manifests in the repo's build/ would be a
 * second copy of every declaration.
 */
private fun buildDirFor(project: Project): File {
    val cache = project.providers.environmentVariable("XDG_CACHE_HOME").orNull?.takeIf { it.isNotEmpty() }
        ?: "${System.getProperty("user.home")}/.cache"
    val path = project.projectDir.canonicalPath
    val hash = MessageDigest.getInstance("SHA-256").digest(path.toByteArray())
        .take(6).joinToString("") { "%02x".format(it) }
    return File("$cache/loadout/build/${project.projectDir.name}-$hash")
}
