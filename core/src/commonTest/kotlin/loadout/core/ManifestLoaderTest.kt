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
    fun theReposVersionFloorIsEnforced() {
        val message = refusal(fs(manifest(minToolVersion = "999.0.0")))
        assertTrue("requires loadout >= 999.0.0" in message, message)
        assertTrue("run: loadout self-upgrade" in message, message)
        ManifestLoader.loadRepo(fs(manifest(minToolVersion = TOOL_VERSION)), repo)
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
