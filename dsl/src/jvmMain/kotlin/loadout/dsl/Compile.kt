package loadout.dsl

import loadout.core.LoadoutException
import loadout.core.TOOL_VERSION
import loadout.core.manifest.ChezmoiData
import loadout.core.manifest.Glob
import loadout.core.manifest.Lock
import loadout.core.manifest.LockFile
import loadout.core.manifest.ManifestAssembler
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okio.FileSystem
import okio.Path.Companion.toPath
import java.io.File
import java.lang.reflect.InvocationTargetException
import kotlin.system.exitProcess

/**
 * `loadout compile`'s last step, run by the Gradle plugin on the compiled
 * manifests: load every class (a repo's declarations are top-level values,
 * registered as their file initialises), assemble and check what they
 * declared, and write the lock.
 *
 * Arguments: `<repo root> <classes dir>… -- <source glob>…`.
 */
fun main(args: Array<String>) {
    val split = args.indexOf("--")
    if (args.size < 2 || split < 2) {
        System.err.println("usage: Compile <repo root> <classes dir>... -- <source glob>...")
        exitProcess(2)
    }
    val repoRoot = args[0].toPath()
    val classDirs = args.toList().subList(1, split).map(::File)
    val sources = args.toList().drop(split + 1)
    try {
        val folders = manifestFolders(FileSystem.SYSTEM, repoRoot, sources)
        // Each declaration's folder is its file's: the first frame up the
        // stack from a manifest file (top-level code, an object's, a lambda's
        // — Kotlin records the source file's name on every class) says which.
        Origins.resolver = { what ->
            StackWalker.getInstance().walk { frames ->
                frames.map { it.fileName?.let(folders::get) }.filter { it != null }.findFirst().orElse(null)
            } ?: throw DslException(
                "can't tell which manifest file declares $what; declare it in a file " +
                    "the sources globs match, or say where with Dir(\"<dir>\").",
            )
        }
        loadAll(classDirs)
        val draft = Registry.current.draft()
        val manifest = ManifestAssembler.assemble(
            draft.copy(manifest = draft.manifest.copy(layout = draft.manifest.layout.copy(sources = sources))),
            FileSystem.SYSTEM,
            repoRoot,
        )
        val lock = Lock(
            toolVersion = TOOL_VERSION,
            sources = LockFile.sourcesHash(FileSystem.SYSTEM, repoRoot, sources),
            manifest = manifest,
        )
        writeIfChanged(repoRoot / LockFile.NAME, LockFile.encode(lock))
        // Warnings, not refusals: the lock is written either way.
        for (warning in unusedWarnings(draft, manifest, Registry.current.spares)) println("warning: $warning")
        val transitional = Registry.current.transitional
        if (transitional.isNotEmpty()) {
            val done = doneScripts(repoRoot / manifest.layout.state, manifest.machines.keys)
            for (warning in transitionalWarnings(manifest, transitional, done)) println("warning: $warning")
        }
        // A repo with dotfiles gets their templates' data and partial beside them.
        manifest.layout.configs?.let { configs ->
            for ((path, text) in ChezmoiData.files(manifest, configs)) {
                val target = repoRoot / path
                target.parent?.let(FileSystem.SYSTEM::createDirectories)
                writeIfChanged(target, text)
            }
        }
    } catch (e: LoadoutException) {
        System.err.println("error: ${e.message}")
        exitProcess(1)
    }
}

/**
 * Each machine's scripts its state file says are done. A missing or
 * unreadable file is a machine that has done nothing: never a reason to
 * call a script finished.
 */
private fun doneScripts(stateDir: okio.Path, machines: Set<String>): Map<String, Set<String>> =
    machines.associateWith { machine ->
        val file = stateDir / "$machine.json"
        runCatching {
            val scripts = Json.parseToJsonElement(FileSystem.SYSTEM.read(file) { readUtf8() }).jsonObject["scripts"]?.jsonObject
            scripts.orEmpty().filterValues { it.jsonObject["status"]?.jsonPrimitive?.content == "done" }.keys
        }.getOrDefault(emptySet())
    }

/** Unchanged content leaves the file alone: a compile that changed nothing shows nothing in git. */
private fun writeIfChanged(target: okio.Path, text: String) {
    if (!FileSystem.SYSTEM.exists(target) || FileSystem.SYSTEM.read(target) { readUtf8() } != text) {
        FileSystem.SYSTEM.write(target) { writeUtf8(text) }
    }
}

/**
 * Initialise every class under [dirs], in name order. Initialising a file's
 * facade runs its top-level declarations; other classes (a data schema, a
 * helper) initialise harmlessly. A mistake a declaration throws surfaces
 * as itself, not as the JVM's initializer wrapper.
 */
private fun loadAll(dirs: List<File>) {
    val loader = Thread.currentThread().contextClassLoader
    val names = dirs.flatMap { dir ->
        dir.walkTopDown()
            .filter { it.isFile && it.name.endsWith(".class") && '$' !in it.name }
            .map { it.relativeTo(dir).path.removeSuffix(".class").replace(File.separatorChar, '.') }
            .toList()
    }.filterNot { it == "META-INF" || it.endsWith("module-info") }.sorted()
    for (name in names) {
        try {
            Class.forName(name, true, loader)
        } catch (e: ExceptionInInitializerError) {
            throw unwrap(e)
        } catch (e: InvocationTargetException) {
            throw unwrap(e)
        }
    }
}

/**
 * Each manifest file's name -> its repo-relative folder: how a declaration
 * knows where it was written. Names are unique across the repo (all manifests
 * share one package, and the JVM knows a class's source file only by name),
 * so two files of one name are refused, both named.
 */
internal fun manifestFolders(fs: FileSystem, repoRoot: okio.Path, sources: List<String>): Map<String, String> {
    val files = sources.flatMap { Glob.expand(fs, repoRoot, it) }.distinct()
    val byName = files.groupBy { it.name }
    val clashes = byName.filterValues { it.size > 1 }
    if (clashes.isNotEmpty()) {
        throw DslException(
            "manifest file names must be unique: " + clashes.entries.joinToString("; ") { (name, paths) ->
                "$name in " + paths.joinToString(" and ") { Glob.relative(repoRoot, it.parent!!).ifEmpty { "the repo root" } }
            },
        )
    }
    return byName.mapValues { (_, paths) -> Glob.relative(repoRoot, paths.single().parent!!) }
}

private fun unwrap(e: Throwable): Throwable {
    var cause: Throwable = e
    while ((cause is ExceptionInInitializerError || cause is InvocationTargetException) && cause.cause != null) {
        cause = cause.cause!!
    }
    return cause
}
