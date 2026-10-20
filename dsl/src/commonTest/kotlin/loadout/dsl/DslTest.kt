package loadout.dsl

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import loadout.core.manifest.Lock
import loadout.core.manifest.LockFile
import loadout.core.manifest.ManifestAssembler
import loadout.core.manifest.ManifestDraft
import loadout.core.manifest.ManifestException
import loadout.core.model.Manifest
import okio.Path.Companion.toPath
import okio.fakefilesystem.FakeFileSystem
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DslTest {
    private val repoRoot = "/repo".toPath()

    private fun assemble(draft: ManifestDraft, vararg files: String): Manifest {
        val fs = FakeFileSystem()
        fs.createDirectories(repoRoot)
        for (file in files) {
            (repoRoot / file).parent?.let(fs::createDirectories)
            fs.write(repoRoot / file) { writeUtf8("#!/bin/sh\n") }
        }
        return ManifestAssembler.assemble(draft, fs, repoRoot)
    }

    private fun refusal(vararg files: String, block: () -> Unit): String =
        assertFailsWith<loadout.core.LoadoutException> { assemble(buildManifest(block), *files) }.message!!

    class Data : MachineData() {
        var work by flag(false)
        val kitty by table(::Kitty)

        class Kitty : MachineData() {
            var opacity by number(0.85)
        }
    }

    @Test
    fun aOneVariantProgramIsInstalledWithoutNamingIt() {
        val manifest = assemble(
            buildManifest {
                layout(state = "state")
                val jq = root.program("jq") { installVia(Builtin.brew) }
                val fd = root.program("fd") { installVia(Builtin.brew, Builtin.omarchy) }
                machine("m") {
                    install(jq)
                    install(Builtin.omarchy, fd)
                }
            },
        )
        assertEquals(mapOf("jq" to "brew", "fd" to "omarchy"), manifest.machines.getValue("m").pm)
    }

    @Test
    fun aProgramWithSeveralVariantsMustSayWhich() {
        val message = refusal {
            layout(state = "state")
            val fd = root.program("fd") { installVia(Builtin.brew, Builtin.omarchy) }
            machine("m") { install(fd) }
        }
        assertTrue("machine 'm' installs 'fd' without saying how (it has: brew, omarchy)" in message, message)
    }

    @Test
    fun anInstallerRequirementBecomesEveryProgramsDependencyButItsOwn() {
        val manifest = assemble(
            buildManifest {
                layout(state = "state")
                val setupDnf = root.program("setup-dnf") { installVia(Builtin.dnf { present("true") ; command = "true" }) }
                val curl = root.program("curl") { installVia(Builtin.dnf) }
                Builtin.dnf.requires(setupDnf)
                machine("m") { install(Builtin.dnf, setupDnf, curl) }
            },
        )
        assertEquals(listOf("setup-dnf"), manifest.dependenciesOf("curl", "dnf"))
        assertEquals(emptyList(), manifest.dependenciesOf("setup-dnf", "dnf"))
        assertEquals(listOf("setup-dnf", "curl"), ManifestAssembler.installOrder(manifest, listOf("curl", "setup-dnf"), manifest.machines.getValue("m").pm))
    }

    @Test
    fun aYesNoCheckRecordsNoVersion() {
        val manifest = assemble(
            buildManifest {
                layout(state = "state")
                root.program("setup-dnf") { installVia(Builtin.dnf { managedBy("setup-dnf.sh") }) }
            },
            "setup-dnf.sh",
        )
        val check = manifest.resolveInstall("setup-dnf", "dnf").check!!
        assertEquals("file:setup-dnf.sh check", check.command)
        assertNull(check.regex)
    }

    @Test
    fun aMachinePicksAScriptVariant() {
        val manifest = assemble(
            buildManifest {
                layout(state = "state")
                val keyboard = root.script("keyboard", "fn swap") {
                    needsSudo()
                    variant("arch") { managedBy("arch.sh") }
                    variant("fedora") { managedBy("fedora.sh") }
                }
                machine("m") { run(keyboard.variant("arch")) }
            },
            "arch.sh",
            "fedora.sh",
        )
        val step = manifest.forMachine("m").scripts.getValue("keyboard")
        assertEquals("arch.sh", step.file)
        assertTrue(step.sudo)
        assertEquals("fn swap", step.description)
    }

    @Test
    fun aScriptWithVariantsNeedsOnePicked() {
        val message = refusal("a.sh") {
            layout(state = "state")
            val s = root.script("s") { variant("a") { managedBy("a.sh") } }
            machine("m") { run(s) }
        }
        assertTrue("machine 'm' runs 's' without saying which variant (has: a)" in message, message)
    }

    @Test
    fun dataIsTypedAndMergedLikeContractTwo() {
        val manifest = assemble(
            buildManifest {
                layout(state = "state")
                machineData(::Data)
                val work = profile("work") { data(::Data) { work = true } }
                machine("m") {
                    extends(work)
                    data(::Data) { kitty.opacity = 0.9 }
                }
            },
        )
        val data = manifest.machines.getValue("m").data
        assertEquals(JsonPrimitive(true), data["work"])
        assertEquals(JsonPrimitive(0.9), data.getValue("kitty").jsonObject["opacity"])
    }

    @Test
    fun twoProfilesSettingADataKeyDifferentlyIsAnError() {
        val message = refusal {
            layout(state = "state")
            machineData(::Data)
            val a = profile("a") { data(::Data) { work = true } }
            val b = profile("b") { data(::Data) { work = false } }
            machine("m") { extends(a, b) }
        }
        assertTrue("machine 'm': profiles 'a' and 'b' set data key 'work' differently" in message, message)
    }

    @Test
    fun aManagingScriptsCheckGetsTheArguments() {
        val manifest = assemble(
            buildManifest {
                layout(state = "state")
                val ssh = root.script("setup-ssh") { managedBy("setup-ssh.sh") }
                machine("m") { run(ssh, "id_ed25519") }
            },
            "setup-ssh.sh",
        )
        assertEquals("file:setup-ssh.sh check \"\$@\"", manifest.scripts.getValue("setup-ssh").check)
        assertEquals(listOf("setup-ssh id_ed25519"), manifest.machines.getValue("m").scripts)
    }

    @Test
    fun severalCommandsMustAllPass() {
        val manifest = manifestOf {
            root.script("remote") {
                run("git remote set-url origin a", "git config remote.origin.pushurl b")
                check("test -f x", "test \"$(uname -s)\" != Linux || systemctl is-enabled y")
            }
        }
        val step = manifest.scripts.getValue("remote")
        assertEquals("git remote set-url origin a && git config remote.origin.pushurl b", step.run)
        // One holding || is grouped, so the && can't bind into it.
        assertEquals("test -f x && { test \"$(uname -s)\" != Linux || systemctl is-enabled y; }", step.check)
    }

    @Test
    fun updatesManagedByAScriptListAndUpdateThroughIt() {
        val manifest = manifestOf {
            Dir("tmux").script("tmux-plugins") {
                managedBy("plugins.sh")
                updatesManagedBy("outdated-plugins.sh")
            }
            Dir("zsh").script("zsh-plugins") {
                managedBy("plugins.sh")
                updatesManagedBy("outdated-antidote.sh", name = "antidote")
            }
            Dir("claude").program("claude") {
                custom { command = "true" }
                version(command = "claude --version")
                updatesManagedBy("outdated-claude.sh")
            }
        }
        val tmux = manifest.outdated.getValue("tmux-plugins")
        assertEquals("file:outdated-plugins.sh", tmux.command)
        assertEquals("file:outdated-plugins.sh update {item}", tmux.upgrade)
        assertEquals("tmux", tmux.origin)
        assertEquals("file:outdated-antidote.sh", manifest.outdated.getValue("antidote").command)
        val claude = manifest.programs.getValue("claude").outdated!!
        assertEquals("file:outdated-claude.sh", claude.command)
        assertEquals("file:outdated-claude.sh update", claude.upgrade)
    }

    @Test
    fun aReferenceReadBeforeItsDeclaredIsNamed() {
        // What an initialisation cycle between two files hands the DSL.
        @Suppress("UNCHECKED_CAST")
        val notYet = arrayOfNulls<Step>(1) as Array<Step>
        val message = assertFailsWith<DslException> {
            buildManifest { root.script("java-macos") { runAfter(*notYet) } }
        }.message.orEmpty()
        assertTrue("script 'java-macos' refers to something not declared yet (argument 1)" in message, message)
    }

    @Test
    fun aScriptsOutdatedSourceIsNamedAfterIt() {
        val manifest = assemble(
            buildManifest {
                layout(state = "state")
                Dir("tmux").script("tmux-plugins") {
                    managedBy("plugins.sh")
                    outdated("file:outdated.sh", upgrade = "file:outdated.sh update {item}")
                }
            },
            "tmux/plugins.sh",
            "tmux/outdated.sh",
        )
        assertEquals("tmux", manifest.outdated.getValue("tmux-plugins").origin)
    }

    @Test
    fun aMissingFileIsNamed() {
        val message = refusal {
            layout(state = "state")
            Dir("git").script("setup-git") { managedBy("setup-git.sh") }
        }
        assertTrue("scripts.setup-git: file 'setup-git.sh' not found (relative to git/)" in message, message)
    }

    @Test
    fun theLockRoundTrips() {
        val manifest = assemble(
            buildManifest {
                layout(state = "state")
                val jq = root.program("jq") { installVia(Builtin.brew) }
                machine("m") { install(jq) }
            },
        )
        val lock = Lock(toolVersion = "3.0.0", sources = "abc", manifest = manifest)
        assertEquals(lock, LockFile.decode(LockFile.encode(lock)))
    }

    @Test
    fun aNewerLockFormatIsRefusedByName() {
        val message = assertFailsWith<ManifestException> {
            LockFile.decode("""{"format": 99, "toolVersion": "9.0.0", "sources": "", "manifest": {}}""")
        }.message!!
        assertTrue("newer loadout" in message, message)
    }

    @Test
    fun declaringAProgramTwiceIsAnError() {
        val message = assertFailsWith<DslException> {
            buildManifest {
                root.program("jq") { installVia(Builtin.brew) }
                root.program("jq") { installVia(Builtin.brew) }
            }
        }.message!!
        assertTrue("duplicate program 'jq'" in message, message)
    }
}
