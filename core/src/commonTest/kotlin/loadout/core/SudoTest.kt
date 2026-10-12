package loadout.core

import loadout.core.engine.InstallEngine
import loadout.core.engine.PlanItem
import loadout.core.engine.ScriptRunner
import loadout.core.engine.UpgradeEngine
import loadout.core.engine.VersionChecker
import loadout.core.engine.commandNeedsSudo
import loadout.core.exec.CommandFrame
import loadout.core.manifest.ManifestLoader
import loadout.core.model.OsFamily
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

    private val manifest = ManifestLoader.parse(
        """
        installers:
          sneaky:
            install: 'helper add {pkg}'
            upgrade: 'helper update'
            sudo: true
          plain:
            install: 'plain add {pkg}'
            upgrade: 'plain update'
        programs:
          visible:
            install:
              pacman:
                command: sudo pacman -S visible
          declared:
            via: [sneaky]
          opted-out:
            install:
              sneaky:
                sudo: false
          own-script:
            install:
              plain:
                command: sh setup.sh
                sudo: true
          none:
            via: [plain]
        machines:
          m:
            pm:
              visible: pacman
              declared: sneaky
              opted-out: sneaky
              own-script: plain
              none: plain
        """.trimIndent(),
    )

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
    fun aScriptIsPendingUnlessItsCheckPassesOrItDoesNotApply() {
        val fake = FakeProcessRunner()
        fake.onCommand("test -f done")
        val runner = ScriptRunner(fake, CommandFrame("/repo"))
        assertFalse(runner.pending(ScriptStep(file = "x.sh", check = "test -f done"), OsFamily.LINUX))
        assertTrue(runner.pending(ScriptStep(file = "x.sh", check = "test -f done"), OsFamily.LINUX, force = true))
        assertTrue(runner.pending(ScriptStep(file = "x.sh", check = "test -f missing"), OsFamily.LINUX))
        assertTrue(runner.pending(ScriptStep(file = "x.sh"), OsFamily.LINUX))
        assertFalse(runner.pending(ScriptStep(file = "x.sh", os = listOf("macos")), OsFamily.LINUX))
    }
}
