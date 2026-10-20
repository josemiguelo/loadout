package loadout.gradle

import loadout.core.manifest.Glob
import okio.FileSystem
import okio.Path.Companion.toOkioPath
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.tasks.JavaExec
import org.gradle.api.tasks.SourceSetContainer
import org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension

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
 * manifests and writes loadout.lock.json.
 */
class LoadoutPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        val version = LoadoutPlugin::class.java.`package`.implementationVersion
            ?: error("the loadout plugin's jar has no version")
        val home = System.getenv("LOADOUT_HOME") ?: "${System.getProperty("user.home")}/.local/share/loadout"
        val extension = project.extensions.create("loadout", LoadoutExtension::class.java)

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
