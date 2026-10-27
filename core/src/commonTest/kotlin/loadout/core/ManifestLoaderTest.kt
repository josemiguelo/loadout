package loadout.core

import loadout.core.engine.ConfigException
import loadout.core.engine.ResolutionException
import loadout.core.engine.UpgradeException
import loadout.core.git.GitException
import loadout.core.manifest.ChezmoiData
import loadout.core.manifest.Lock
import loadout.core.manifest.LockFile
import loadout.core.manifest.ManifestException
import loadout.core.manifest.ManifestLoader
import loadout.core.manifest.ToolTooOldException
import loadout.core.model.Manifest
import loadout.core.model.RepoLayout
import loadout.dsl.DslException
import loadout.dsl.machine
import loadout.dsl.manifestOf
import loadout.dsl.meta
import loadout.dsl.root
import okio.Path.Companion.toPath
import okio.fakefilesystem.FakeFileSystem
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** The lock reader: the only way the binary sees a repo's manifests. */
class ManifestLoaderTest {
    private val repo = "/repo".toPath()
    private val sources = listOf("loadout.kt", "programs/**/*.loadout.kt")

    private fun manifest(minToolVersion: String? = null): Manifest = manifestOf {
        meta(name = "test", minToolVersion = minToolVersion)
        val git = root.program("git") { custom { command = "file:install-git.sh" } }
        machine("m") { install(git) }
    }.let { it.copy(layout = RepoLayout(state = "state", configs = "configs", sources = sources)) }

    /** A repo whose lock is current with its sources, with [files] on disk. */
    private fun fs(
        manifest: Manifest = manifest(),
        toolVersion: String = TOOL_VERSION,
        files: List<String> = listOf("install-git.sh"),
    ): FakeFileSystem {
        val fs = FakeFileSystem()
        fs.createDirectories(repo / "programs")
        fs.write(repo / "loadout.kt") { writeUtf8("package repo\n") }
        fs.write(repo / "programs" / "cli.loadout.kt") { writeUtf8("package repo\n") }
        for (file in files) fs.write(repo / file) { writeUtf8("#!/bin/sh\n") }
        val lock = Lock(toolVersion = toolVersion, sources = LockFile.sourcesHash(fs, repo, sources), manifest = manifest)
        fs.write(repo / LockFile.NAME) { writeUtf8(LockFile.encode(lock)) }
        // What compile writes beside the configs.
        manifest.layout.configs?.let { configs ->
            for ((path, text) in ChezmoiData.files(manifest, configs)) {
                fs.createDirectories((repo / path).parent!!)
                fs.write(repo / path) { writeUtf8(text) }
            }
        }
        return fs
    }

    private fun refusal(fs: FakeFileSystem): String =
        assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo) }.message.orEmpty()

    @Test
    fun aCurrentLockLoads() {
        val loaded = ManifestLoader.loadRepo(fs(), repo)
        assertEquals(manifest(), loaded)
        assertEquals(RepoLayout(state = "state", configs = "configs", sources = sources), ManifestLoader.readLayout(fs(), repo))
    }

    @Test
    fun theTemplatesDataMustMatchTheLock() {
        val missing = fs()
        missing.delete(repo / "configs/.chezmoidata/loadout.json")
        assertTrue("configs/.chezmoidata/loadout.json is missing — run: loadout compile" in refusal(missing))

        val edited = fs()
        edited.write(repo / "configs/.chezmoidata/loadout.json") { writeUtf8("{}\n") }
        assertTrue("configs/.chezmoidata/loadout.json doesn't match loadout.lock.json — run: loadout compile" in refusal(edited))
    }

    @Test
    fun thePartialMustBeLoadouts() {
        val missing = fs()
        missing.delete(repo / "configs/.chezmoitemplates/loadout/machine")
        assertTrue("configs/.chezmoitemplates/loadout/machine is missing — run: loadout compile" in refusal(missing))

        val edited = fs()
        edited.write(repo / "configs/.chezmoitemplates/loadout/machine") { writeUtf8("{{ .chezmoi.hostname }}\n") }
        assertTrue("configs/.chezmoitemplates/loadout/machine doesn't match loadout.lock.json" in refusal(edited))
    }

    @Test
    fun theTemplatesDataHoldsTheDefaultsAndEveryMachine() {
        val text = ChezmoiData.render(manifest().copy(data = kotlinx.serialization.json.buildJsonObject { put("work", kotlinx.serialization.json.JsonPrimitive(false)) }))
        val tree = kotlinx.serialization.json.Json.parseToJsonElement(text) as kotlinx.serialization.json.JsonObject
        val loadout = tree.getValue("loadout") as kotlinx.serialization.json.JsonObject
        assertEquals(setOf("defaults", "machines"), loadout.keys)
        assertEquals("false", (loadout.getValue("defaults") as kotlinx.serialization.json.JsonObject).getValue("work").toString())
        assertEquals(setOf("m"), (loadout.getValue("machines") as kotlinx.serialization.json.JsonObject).keys)
    }

    @Test
    fun noLockSaysToCompile() {
        val message = assertFailsWith<ManifestException> { ManifestLoader.loadRepo(FakeFileSystem(), repo) }.message.orEmpty()
        assertTrue("no loadout.lock.json in /repo — run: loadout compile" in message, message)
    }

    @Test
    fun anEditTheLockHasntSeenIsRefused() {
        val fs = fs()
        fs.write(repo / "programs" / "cli.loadout.kt") { writeUtf8("package repo // edited\n") }
        assertTrue("the manifests changed since loadout.lock.json was written — run: loadout compile" in refusal(fs))

        // A new source file counts too.
        val added = fs()
        added.write(repo / "programs" / "new.loadout.kt") { writeUtf8("package repo\n") }
        assertTrue("run: loadout compile" in refusal(added))

        // Files no source glob matches don't.
        val other = fs()
        other.write(repo / "README.md") { writeUtf8("hi\n") }
        ManifestLoader.loadRepo(other, repo)
    }

    @Test
    fun aNewerLockFormatSaysToUpgrade() {
        val fs = fs()
        val text = fs.read(repo / LockFile.NAME) { readUtf8() }.replace("\"format\": 1", "\"format\": 2")
        fs.write(repo / LockFile.NAME) { writeUtf8(text) }
        assertTrue("lock format 2" in refusal(fs) && "run: loadout self-upgrade" in refusal(fs), refusal(fs))
    }

    @Test
    fun aLockFromANewerMinorIsRefusedAndANewerPatchIsNot() {
        val (major, minor, patch) = TOOL_VERSION.split('.').map { it.toInt() }
        val message = refusal(fs(toolVersion = "$major.${minor + 1}.0"))
        assertTrue("loadout.lock.json was compiled by loadout $major.${minor + 1}.0 (you have $TOOL_VERSION)" in message, message)
        assertTrue("run: loadout self-upgrade" in message, message)
        ManifestLoader.loadRepo(fs(toolVersion = "$major.$minor.${patch + 1}"), repo)
        ManifestLoader.loadRepo(fs(toolVersion = "0.1.0"), repo)
    }

    @Test
    fun aNewerMinorsFieldIsRefusedByVersionNotByTheField() {
        val (major, minor) = TOOL_VERSION.split('.').map { it.toInt() }
        val fs = fs(toolVersion = "$major.${minor + 1}.0")
        val text = fs.read(repo / LockFile.NAME) { readUtf8() }.replace("\"manifest\": {", "\"manifest\": {\n    \"fromTheFuture\": true,")
        fs.write(repo / LockFile.NAME) { writeUtf8(text) }
        val message = refusal(fs)
        assertTrue("was compiled by loadout $major.${minor + 1}.0" in message && "run: loadout self-upgrade" in message, message)
    }

    // ─── a child repo's parent (contract 18) ─────────────────────────

    private val parentRoot = "/home/u/dots".toPath()
    private val parentSources = listOf("loadout.kt")

    /** A child repo at [repo] whose parent, at ~/dots, declares a script whose file is there. */
    private fun childFs(): FakeFileSystem {
        val fs = FakeFileSystem()
        fs.createDirectories(parentRoot / "lib")
        fs.write(parentRoot / "loadout.kt") { writeUtf8("package parent\n") }
        fs.write(parentRoot / "lib" / "helper.sh") { writeUtf8("#!/bin/sh\n") }
        val parent = loadout.core.model.ParentLayout(
            name = "dotfiles", path = "~/dots", state = "state",
            sources = parentSources, hash = LockFile.sourcesHash(fs, parentRoot, parentSources),
        )
        val manifest = manifestOf {
            meta(name = "child")
            val helper = loadout.dsl.Dir("parent:lib").script("helper") { managedBy("helper.sh") }
            machine("work") { run(helper) }
        }.let { it.copy(layout = RepoLayout(state = "state", sources = sources, parent = parent)) }
        fs.createDirectories(repo / "programs")
        fs.write(repo / "loadout.kt") { writeUtf8("package repo\n") }
        val lock = Lock(toolVersion = TOOL_VERSION, sources = LockFile.sourcesHash(fs, repo, sources), manifest = manifest)
        fs.write(repo / LockFile.NAME) { writeUtf8(LockFile.encode(lock)) }
        return fs
    }

    private fun childRefusal(fs: FakeFileSystem): String =
        assertFailsWith<ManifestException> { ManifestLoader.loadRepo(fs, repo, home = "/home/u") }.message.orEmpty()

    @Test
    fun aChildLoadsWithItsParentAtItsPath() {
        val fs = childFs()
        assertEquals("parent:lib", ManifestLoader.loadRepo(fs, repo, home = "/home/u").scripts.getValue("helper").origin)
        assertEquals(parentRoot, ManifestLoader.parentRoot(fs, repo, ManifestLoader.readLayout(fs, repo), home = "/home/u"))
    }

    @Test
    fun aParentEditTheChildHasntCompiledIsRefused() {
        val fs = childFs()
        fs.write(parentRoot / "loadout.kt") { writeUtf8("package parent // edited\n") }
        val message = childRefusal(fs)
        assertTrue("parent dotfiles: the manifests changed since loadout.lock.json was written — run: loadout compile" in message, message)
    }

    @Test
    fun aMissingParentOrParentFileIsNamed() {
        val gone = childFs()
        gone.deleteRecursively(parentRoot)
        val message = childRefusal(gone)
        assertTrue("parent dotfiles is not at ~/dots — clone it there" in message, message)
        val noFile = childFs()
        noFile.delete(parentRoot / "lib" / "helper.sh")
        val missing = childRefusal(noFile)
        assertTrue("scripts.helper: file 'helper.sh' not found (relative to parent:lib/)" in missing, missing)
    }

    @Test
    fun theReposVersionFloorIsEnforced() {
        val message = refusal(fs(manifest(minToolVersion = "999.0.0")))
        assertTrue("requires loadout >= 999.0.0" in message, message)
        assertTrue("run: loadout self-upgrade" in message, message)
        ManifestLoader.loadRepo(fs(manifest(minToolVersion = TOOL_VERSION)), repo)
    }

    @Test
    fun aTooOldBinaryIsItsOwnRefusalNamingTheVersionNeeded() {
        val (major, minor) = TOOL_VERSION.split('.').map { it.toInt() }
        val floor = assertFailsWith<ToolTooOldException> { ManifestLoader.loadRepo(fs(manifest(minToolVersion = "999.0.0")), repo) }
        assertEquals("999.0.0", floor.required)
        val newer = assertFailsWith<ToolTooOldException> { ManifestLoader.loadRepo(fs(toolVersion = "$major.${minor + 1}.3"), repo) }
        assertEquals("$major.${minor + 1}.0", newer.required)
        assertTrue(ManifestLoader.toolTooOld(fs(manifest(minToolVersion = "999.0.0")), repo))
        assertFalse(ManifestLoader.toolTooOld(fs(), repo))
        assertFalse(ManifestLoader.toolTooOld(fs(files = emptyList()), repo))
    }

    @Test
    fun aFileTheLockNamesMustStillExist() {
        val message = refusal(fs(files = emptyList()))
        assertTrue("programs.git.install.custom: file 'install-git.sh' not found (relative to the repo root)" in message, message)
    }

    @Test
    fun notALockIsRefusedCleanly() {
        val fs = fs()
        fs.write(repo / LockFile.NAME) { writeUtf8("meta:\n  name: yaml\n") }
        assertTrue("run: loadout compile" in refusal(fs), refusal(fs))
    }

    @Test
    fun everyLoadoutFailureReportsAsACleanOneLiner() {
        // Main.kt catches LoadoutException and nothing else of ours; a type
        // that escapes this hierarchy would reach the user as a stack trace.
        val ours: List<Exception> = listOf(
            ManifestException("x"),
            DslException("x"),
            ResolutionException("x"),
            UpgradeException("x"),
            GitException("x"),
            ConfigException("x"),
        )
        for (e in ours) assertTrue(e is LoadoutException, "${e::class.simpleName} is not a LoadoutException")
    }
}
