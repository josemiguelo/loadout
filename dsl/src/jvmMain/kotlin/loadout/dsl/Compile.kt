package loadout.dsl

import loadout.core.LoadoutException
import loadout.core.TOOL_VERSION
import loadout.core.manifest.ChezmoiData
import loadout.core.manifest.Glob
import loadout.core.manifest.Lock
import loadout.core.manifest.LockFile
import loadout.core.manifest.ManifestAssembler
import loadout.core.model.Origin
import loadout.core.model.ParentLayout
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
 * Arguments: `<repo root> <classes dir>… -- <source glob>…`, then for a
 * child repo (contract 18) `--parent <name> <path as written> <parent root>
 * <classes dir>… -- <source glob>…`: the parent's classes load first, into
 * a registry of their own, and the child's lock holds what the child's
 * machines use of them, with `parent:` origins.
 */
fun main(args: Array<String>) {
    val all = args.toList()
    val parentAt = all.indexOf("--parent")
    val own = if (parentAt < 0) all else all.subList(0, parentAt)
    val split = own.indexOf("--")
    val parentArgs = if (parentAt < 0) null else all.drop(parentAt + 1)
    val parentSplit = parentArgs?.indexOf("--") ?: -1
    if (own.size < 2 || split < 2 || (parentArgs != null && (parentArgs.size < 4 || parentSplit < 4))) {
        System.err.println(
            "usage: Compile <repo root> <classes dir>... -- <source glob>... " +
                "[--parent <name> <path> <parent root> <classes dir>... -- <source glob>...]",
        )
        exitProcess(2)
    }
    val repoRoot = own[0].toPath()
    val classDirs = own.subList(1, split).map(::File)
    val sources = own.drop(split + 1)
    val parent = parentArgs?.let {
        ParentArgs(it[0], it[1], it[2].toPath(), it.subList(3, parentSplit).map(::File), it.drop(parentSplit + 1))
    }
    try {
        parent?.let(::requireCurrentParent)
        val folders = manifestFolders(FileSystem.SYSTEM, repoRoot, sources, parent)
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
        val parentRegistry = parent?.let { Registry(isParent = true).also { registry -> Registry.into(registry) { loadAll(it.classDirs) } } }
        loadAll(classDirs)
        val draft = if (parent == null) Registry.current.draft() else Registry.current.draftOver(parentRegistry!!, parent.name)
        val parentLayout = parent?.let {
            ParentLayout(
                name = it.name,
                path = it.path,
                state = parentRegistry!!.layout.state,
                configs = parentRegistry.layout.configs,
                sources = it.sources,
                hash = LockFile.sourcesHash(FileSystem.SYSTEM, it.root, it.sources),
            )
        }
        val manifest = ManifestAssembler.assemble(
            draft.copy(
                manifest = draft.manifest.copy(
                    layout = draft.manifest.layout.copy(sources = sources, parent = parentLayout),
                ),
            ),
            FileSystem.SYSTEM,
            repoRoot,
            parent?.root,
        )
        val lock = Lock(
            toolVersion = TOOL_VERSION,
            sources = LockFile.sourcesHash(FileSystem.SYSTEM, repoRoot, sources),
            manifest = manifest,
        )
        writeIfChanged(repoRoot, repoRoot / LockFile.NAME, LockFile.encode(lock))
        // Warnings, not refusals: the lock is written either way. A parent's
        // declarations are the parent's compile's to judge.
        val inherited = parentRegistry?.declaredNames().orEmpty()
        for (warning in unusedWarnings(draft, manifest, Registry.current.spares, inherited)) println("warning: $warning")
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
                writeIfChanged(repoRoot, target, text)
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

/**
 * The parent's own lock is current and has no parent of its own: the globs
 * the child compiles came from it, so a stale one means an unknown file set.
 */
private fun requireCurrentParent(parent: ParentArgs) {
    val path = parent.root / LockFile.NAME
    if (!FileSystem.SYSTEM.exists(path)) {
        throw DslException("parent ${parent.name} (${parent.path}) has no ${LockFile.NAME} — run: loadout compile there first")
    }
    val lock = LockFile.decode(FileSystem.SYSTEM.read(path) { readUtf8() }, "parent ${parent.name}'s ${LockFile.NAME}")
    if (lock.manifest.layout.parent != null) {
        throw DslException("parent ${parent.name} is itself a child: a parent can't have a parent")
    }
    if (LockFile.sourcesHash(FileSystem.SYSTEM, parent.root, parent.sources) != lock.sources) {
        throw DslException("parent ${parent.name}: ${LockFile.NAME} is older than its manifests — run: loadout compile there first")
    }
}

/** A child repo's parent, from the arguments. */
internal class ParentArgs(
    val name: String,
    val path: String,
    val root: okio.Path,
    val classDirs: List<File>,
    val sources: List<String>,
)

/**
 * Unchanged content leaves the file alone: a compile that changed nothing
 * shows nothing in git. Nothing lands outside [repoRoot]: a child's compile
 * never writes into its parent (contract 18).
 */
private fun writeIfChanged(repoRoot: okio.Path, target: okio.Path, text: String) {
    check(target.normalized().toString().startsWith(repoRoot.normalized().toString().trimEnd('/') + "/")) {
        "compile writes only under the repo root: $target"
    }
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
internal fun manifestFolders(fs: FileSystem, repoRoot: okio.Path, sources: List<String>): Map<String, String> =
    manifestFolders(fs, repoRoot, sources, null)

/**
 * As above, over a child repo and its [parent]: a parent's file maps to its
 * `parent:` folder, and a name in both repos is refused, both named.
 */
internal fun manifestFolders(fs: FileSystem, repoRoot: okio.Path, sources: List<String>, parent: ParentArgs?): Map<String, String> {
    // (file, its folder as an origin, where messages say it is)
    val own = sources.flatMap { Glob.expand(fs, repoRoot, it) }.distinct().map { file ->
        val folder = Glob.relative(repoRoot, file.parent!!)
        Triple(file, folder, folder.ifEmpty { "the repo root" } + if (parent != null) " (this repo)" else "")
    }
    val inherited = parent?.let { p ->
        p.sources.flatMap { Glob.expand(fs, p.root, it) }.distinct().map { file ->
            val folder = Glob.relative(p.root, file.parent!!)
            Triple(file, Origin.ofParent(folder), folder.ifEmpty { "its root" } + " (parent ${p.name})")
        }
    }.orEmpty()
    for ((_, origin, _) in own) {
        if (parent != null && Origin.isParent(origin)) throw DslException("a child repo's folder can't start with ${Origin.PARENT}: $origin")
    }
    val byName = (inherited + own).groupBy { it.first.name }
    val clashes = byName.filterValues { it.size > 1 }
    if (clashes.isNotEmpty()) {
        throw DslException(
            "manifest file names must be unique: " + clashes.entries.joinToString("; ") { (name, files) ->
                "$name in " + files.joinToString(" and ") { it.third }
            },
        )
    }
    return byName.mapValues { (_, files) -> files.single().second }
}

private fun unwrap(e: Throwable): Throwable {
    var cause: Throwable = e
    while ((cause is ExceptionInInitializerError || cause is InvocationTargetException) && cause.cause != null) {
        cause = cause.cause!!
    }
    return cause
}
