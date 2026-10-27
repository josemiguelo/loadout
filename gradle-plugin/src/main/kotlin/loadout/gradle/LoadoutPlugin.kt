package loadout.gradle

import loadout.core.manifest.Glob
import loadout.core.manifest.LockFile
import org.gradle.api.GradleException
import okio.FileSystem
import okio.Path.Companion.toOkioPath
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.tasks.JavaExec
import org.gradle.api.tasks.SourceSetContainer
import org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension
import java.io.File
import java.security.MessageDigest

/**
 * `loadout { sources(…) }`: the manifest globs, in compile order; and for a
 * child repo, `parent(name, path)`: the repo it builds on (contract 18).
 */
open class LoadoutExtension {
    internal val sources = mutableListOf<String>()
    internal var parent: Pair<String, String>? = null

    fun sources(vararg globs: String) {
        sources += globs
    }

    /**
     * This repo is a child of the repo at [path] (`~/…`, absolute, or relative
     * to this one): its manifests use the parent's programs, scripts,
     * installers, profiles and data schema by name. [name] is what messages
     * and `explain` call it.
     */
    fun parent(name: String, path: String) {
        parent = name to path
    }
}

/** A child's parent, resolved: its checkout and the globs its own lock declares. */
private class ResolvedParent(val name: String, val path: String, val root: File, val sources: List<String>)

/** [path] as `parent(path = …)` means it: `~/…` under the home, absolute as is, else under the child. */
private fun parentRoot(path: String, projectDir: File): File = when {
    path == "~" || path.startsWith("~/") -> File(System.getProperty("user.home") + path.removePrefix("~"))
    File(path).isAbsolute -> File(path)
    else -> File(projectDir, path)
}.canonicalFile

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
        // A child's parent compiles on its own, and the child against it; a
        // repo without a parent leaves it empty.
        val sourceSets = project.extensions.getByType(SourceSetContainer::class.java)
        val parentSet = sourceSets.create("parent")
        project.dependencies.add(parentSet.implementationConfigurationName, "io.github.josemiguelo.loadout:dsl:$version")
        project.dependencies.add("implementation", parentSet.output)
        var resolvedParent: ResolvedParent? = null

        project.afterEvaluate {
            val kotlin = project.extensions.getByType(KotlinJvmProjectExtension::class.java)
            fun compileExactly(set: String, dir: File, globs: List<String>) {
                val root = dir.toOkioPath()
                val files = globs.flatMap { Glob.expand(FileSystem.SYSTEM, root, it) }.map { Glob.relative(root, it) }.distinct()
                kotlin.sourceSets.getByName(set).kotlin.apply {
                    setSrcDirs(listOf(dir))
                    setIncludes(files.ifEmpty { listOf("<no manifests>") })
                }
            }
            compileExactly("main", project.projectDir, extension.sources)
            resolvedParent = extension.parent?.let { (name, path) ->
                val root = parentRoot(path, project.projectDir)
                if (!root.isDirectory) throw GradleException("parent(path = $path) in build.gradle.kts names no directory")
                val lock = File(root, LockFile.NAME)
                if (!lock.isFile) {
                    throw GradleException("parent $name ($path) has no ${LockFile.NAME} — run: loadout compile there first")
                }
                ResolvedParent(name, path, root, LockFile.decode(lock.readText(), "parent $name's ${LockFile.NAME}").manifest.layout.sources)
            }
            val parent = resolvedParent
            if (parent == null) {
                kotlin.sourceSets.getByName("parent").kotlin.apply { setSrcDirs(emptyList<File>()) }
            } else {
                compileExactly("parent", parent.root, parent.sources)
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
                val own = listOf(project.projectDir.path) + main.output.classesDirs.files.map { it.path } + "--" + extension.sources
                val parent = resolvedParent ?: return@add own
                own + "--parent" + parent.name + parent.path + parent.root.path +
                    parentSet.output.classesDirs.files.map { it.path } + "--" + parent.sources
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
