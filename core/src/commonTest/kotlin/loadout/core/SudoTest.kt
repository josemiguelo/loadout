package loadout.core

import loadout.core.engine.InstallEngine
import loadout.core.engine.PlanItem
import loadout.core.engine.ScriptRunner
import loadout.core.engine.UpgradeEngine
import loadout.core.engine.VersionChecker
import loadout.core.engine.commandNeedsSudo
import loadout.core.exec.CommandFrame
import loadout.dsl.Builtin
import loadout.dsl.invoke
import loadout.dsl.machine
import loadout.dsl.manifestOf
import loadout.dsl.root
import loadout.core.model.ScriptStep
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Which steps need sudo's password: what makes a run ask for it upfront. */
class SudoTest {
    @Test
    fun aCommandNeedsSudoOnlyWhenItRunsSudo() {
        assertTrue(commandNeedsSudo("sudo pacman -S --noconfirm kitty"))
        assertTrue(commandNeedsSudo("cd /tmp && sudo -E make install"))
        assertTrue(commandNeedsSudo("x=1; sudo tee /etc/x.conf"))
        assertFalse(commandNeedsSudo("script -q pseudo-tty"))
        assertFalse(commandNeedsSudo("sudoku --solve"))
        assertFalse(commandNeedsSudo("omarchy pkg add kitty"))
        assertFalse(commandNeedsSudo("sh 'setup.sh' install"))
    }

    private val manifest = manifestOf {
        val sneaky = root.installer("sneaky") {
            install = "helper add {pkg}"
            upgrade = "helper update"
            needsSudo()
        }
        val plain = root.installer("plain") {
            install = "plain add {pkg}"
            upgrade = "plain update"
        }
        val visible = root.program("visible") { installVia(Builtin.pacman { command = "sudo pacman -S visible" }) }
        val declared = root.program("declared") { installVia(sneaky) }
        val optedOut = root.program("opted-out") { installVia(sneaky { needsSudo(false) }) }
        val ownScript = root.program("own-script") {
            installVia(plain {
                command = "sh setup.sh"
                needsSudo()
            })
        }
        val none = root.program("none") { installVia(plain) }
        machine("m") {
            install(visible, declared, optedOut, ownScript, none)
        }
    }

    @Test
    fun anInstallNeedsSudoWhenItsCommandRunsItOrItsVariantOrInstallerSaysSo() {
        val runner = FakeProcessRunner()
        val plan = InstallEngine(runner, VersionChecker(runner), CommandFrame("/repo"))
            .plan(manifest, "m", listOf("visible", "declared", "opted-out", "own-script", "none"), emptyMap()) { true }
        val sudo = plan.filterIsInstance<PlanItem.Install>().associate { it.program to it.sudo }
        assertEquals(
            mapOf("visible" to true, "declared" to true, "opted-out" to false, "own-script" to true, "none" to false),
            sudo,
        )
    }

    @Test
    fun anUpgradeNeedsSudoWhenItsInstallerSaysSo() {
        val steps = UpgradeEngine.plan(manifest, "m", listOf("sneaky", "plain"))
        assertEquals(mapOf("helper update" to true, "plain update" to false), steps.associate { it.command to it.sudo })
    }

    @Test
    fun aScriptNeedsSudoWhenItSaysSoOrItsCommandRunsIt() {
        val runner = ScriptRunner(FakeProcessRunner(), CommandFrame("/repo"))
        assertTrue(runner.needsSudo(ScriptStep(file = "x.sh", sudo = true)))
        assertTrue(runner.needsSudo(ScriptStep(run = "sudo systemctl enable --now x")))
        assertFalse(runner.needsSudo(ScriptStep(file = "x.sh")))
        assertFalse(runner.needsSudo(ScriptStep(run = "systemctl --user enable x")))
    }

    @Test
    fun aScriptIsPendingUnlessItsCheckPasses() {
        val fake = FakeProcessRunner()
        fake.onCommand("test -f done")
        val runner = ScriptRunner(fake, CommandFrame("/repo"))
        assertFalse(runner.pending(ScriptStep(file = "x.sh", check = "test -f done")))
        assertTrue(runner.pending(ScriptStep(file = "x.sh", check = "test -f done"), force = true))
        assertTrue(runner.pending(ScriptStep(file = "x.sh", check = "test -f missing")))
        assertTrue(runner.pending(ScriptStep(file = "x.sh")))
    }
}
