package loadout.dsl

import loadout.core.LoadoutException
import loadout.core.manifest.ManifestAssembler
import loadout.core.model.RepoLayout
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** What `loadout compile` warns about: declarations no machine uses, and spare marks that aren't true. */
class UnusedTest {
    private fun warnings(block: () -> Unit): List<String> {
        val previous = Registry.current
        val registry = Registry()
        Registry.current = registry
        try {
            block()
        } finally {
            Registry.current = previous
        }
        val draft = registry.draft().let { it.copy(manifest = it.manifest.copy(layout = RepoLayout(state = "state"))) }
        return unusedWarnings(draft, ManifestAssembler.assembleWithoutFiles(draft), registry.spares)
            .map { it.substringBefore(" — ") }
    }

    @Test
    fun aRepoEveryMachineUsesHasNoWarnings() {
        val out = warnings {
            val base = program(name = "base") {
                installVia(
                    Builtin.dnf,
                )
            }
            val tool = program(name = "tool") {
                installVia(
                    Builtin.dnf,
                )
                dependsOn(base)
            }
            val step = script(name = "step") { run("true") }
            val shared = profile(name = "shared") { run(step) }
            machine(hostname = "m1") {
                extends(shared)
                install(tool)
            }
        }
        assertEquals(emptyList(), out)
    }

    @Test
    fun whatNoMachineUsesIsNamed() {
        val out = warnings {
            installer(name = "fake") { install = "true" }
            program(name = "orphan") {
                installVia(
                    Builtin.dnf,
                )
            }
            val tool = program(name = "tool") {
                installVia(
                    Builtin.dnf,
                    Builtin.brew,
                )
            }
            val jq = program(name = "jq") {
                installVia(
                    Builtin.brew,
                )
            }
            script(name = "idle") { run("true") }
            val keyboard = script(name = "keyboard") {
                variant(name = "arch") { run("true") }
                variant(name = "fedora") { run("true") }
            }
            profile(name = "lonely") {}
            machine(hostname = "m1") {
                via(Builtin.dnf) {
                    install(tool)
                }
                install(jq)
                run(keyboard.variant(name = "arch"))
            }
        }
        assertEquals(
            listOf(
                "installer 'fake' installs nothing a machine uses",
                "profile 'lonely' isn't extended by any machine",
                "program 'orphan' isn't installed on any machine",
                "program 'tool': machine 'm1' installs other programs via 'brew', but not tool",
                "script 'idle' isn't run on any machine",
                "script 'keyboard': no machine runs it as 'fedora'",
            ),
            out,
        )
    }

    @Test
    fun aWayToInstallThroughAnInstallerNoMachineUsesIsNotAWarning() {
        val out = warnings {
            val ripgrep = program(name = "ripgrep") {
                installVia(
                    Builtin.dnf,
                    Builtin.apt,
                    Builtin.pacman,
                    Builtin.brew,
                )
            }
            machine(hostname = "laptop") {
                via(Builtin.dnf) {
                    install(ripgrep)
                }
            }
        }
        assertEquals(emptyList(), out)
    }

    @Test
    fun aSpareMarkOnAPickedWayToInstallIsAWarning() {
        val out = warnings {
            val tool = program(name = "tool") {
                installVia(
                    Builtin.dnf {
                        spare(reason = "for Fedora")
                    },
                    Builtin.brew,
                )
            }
            machine(hostname = "m1") {
                via(Builtin.dnf) {
                    install(tool)
                }
            }
        }
        assertEquals(listOf("program 'tool' via 'dnf' is marked spare, but a machine uses it"), out)
    }

    @Test
    fun aSpareMarkOnAScriptVariantAMachineRunsIsAWarning() {
        val out = warnings {
            val keyboard = script(name = "keyboard") {
                variant(name = "arch") {
                    spare(reason = "no Arch machine")
                    run("true")
                }
                variant(name = "fedora") { run("true") }
            }
            machine(hostname = "m1") { run(keyboard.variant(name = "arch")) }
            machine(hostname = "m2") { run(keyboard.variant(name = "fedora")) }
        }
        assertEquals(listOf("script 'keyboard' as 'arch' is marked spare, but a machine uses it"), out)
    }

    @Test
    fun spareSilencesTheWarningAndASpareProfileCountsAsUsed() {
        val out = warnings {
            val fedoraOnly = program(name = "fedora-only") {
                installVia(
                    Builtin.dnf,
                )
            }
            val tool = program(name = "tool") {
                installVia(
                    Builtin.dnf,
                    Builtin.brewCask {
                        spare(reason = "for macOS")
                    },
                )
            }
            val keyboard = script(name = "keyboard") {
                variant(name = "arch") { run("true") }
                variant(name = "fedora") {
                    spare(reason = "no Fedora machine")
                    run("true")
                }
            }
            program(name = "kept") {
                spare(reason = "for later")
                installVia(
                    Builtin.dnf,
                )
            }
            profile(name = "fedora") {
                spare(reason = "no Fedora machine")
                install(fedoraOnly)
            }
            machine(hostname = "m1") {
                via(Builtin.dnf) {
                    install(tool)
                }
                run(keyboard.variant(name = "arch"))
            }
        }
        assertEquals(emptyList(), out)
    }

    @Test
    fun aSpareMarkOnSomethingUsedIsAWarning() {
        val out = warnings {
            val tool = program(name = "tool") {
                spare(reason = "for later")
                installVia(
                    Builtin.dnf,
                )
            }
            machine(hostname = "m1") { install(tool) }
        }
        assertEquals(listOf("program 'tool' is marked spare, but machine 'm1' uses it"), out)
    }

    @Test
    fun aMachineCantBeSpare() {
        val message = assertFailsWith<LoadoutException> {
            warnings { machine(hostname = "m1") { spare(reason = "unused") } }
        }.message.orEmpty()
        assertTrue("machine 'm1' is marked spare, but only a profile can be" in message, message)
    }
}
