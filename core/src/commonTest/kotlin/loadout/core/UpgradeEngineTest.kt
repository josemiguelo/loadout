package loadout.core

import loadout.core.engine.UpgradeEngine
import loadout.core.engine.UpgradeException
import loadout.dsl.machine
import loadout.dsl.invoke
import loadout.dsl.manifestOf
import loadout.dsl.root
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

private val MANIFEST = manifestOf {
    val pm = root.installer("pm") {
        install = "install {pkg}"
        upgrade = "pm upgrade -y"
        check = "pm show {pkg}"
        regex = "([0-9.]+)"
    }
    val rolling = root.installer("rolling") {
        install = "roll {pkg}"
        upgrade = "roll -Syu"
        check = "roll -Q {pkg}"
        regex = "([0-9.]+)"
    }
    val manual = root.installer("manual") {
        install = "by hand {pkg}"
        check = "true"
        regex = "([0-9.]+)"
    }
    val alpha = root.program("alpha") { installVia(pm) }
    val bravo = root.program("bravo") { installVia(pm) }
    val charlie = root.program("charlie") { installVia(rolling) }
    val delta = root.program("delta") { installVia(manual) }
    machine("m1") { install(alpha, bravo, charlie, delta) }
    machine("m2") { install(delta) }
}

class UpgradeEngineTest {
    private fun engine() = UpgradeEngine

    @Test
    fun anUpgradeIsAlwaysTheWholeMechanism() {
        // Two programs from one installer, one command — and the command is
        // the mechanism's own sweep, not a package list.
        val plan = engine().plan(MANIFEST, "m1", listOf("pm"))
        assertEquals(1, plan.size)
        assertEquals("pm upgrade -y", plan.single().command)
        assertEquals(listOf("alpha", "bravo"), plan.single().covers)
    }

    @Test
    fun namingAProgramPointsAtItsMechanism() {
        val e = assertFailsWith<UpgradeException> { engine().plan(MANIFEST, "m1", listOf("alpha")) }
        assertTrue("upgrades are whole-mechanism" in e.message.orEmpty(), e.message.orEmpty())
    }

    @Test
    fun amechanismThisMachineDoesNotUseIsRefused() {
        // The safety property: `upgrade` can only run mechanisms this
        // machine's mapping actually installs through. Without it a repo
        // that maps nothing to brew could still run the real `brew upgrade`.
        val e = assertFailsWith<UpgradeException> { engine().plan(MANIFEST, "m2", listOf("pm")) }
        assertTrue("not used by machine 'm2'" in e.message.orEmpty(), e.message.orEmpty())
    }

    @Test
    fun anInstallerWithNoUpgradeCommandIsAnError() {
        val e = assertFailsWith<UpgradeException> { engine().plan(MANIFEST, "m1", listOf("manual")) }
        assertTrue("declares no upgrade command" in e.message.orEmpty(), e.message.orEmpty())
    }

    @Test
    fun onlyMechanismsThisMachineActuallyUsesAreOffered() {
        val available = engine().upgradableInstallers(MANIFEST, "m1")
        assertEquals(setOf("pm", "rolling"), available.keys, "manual declares no upgrade")
        assertEquals(listOf("alpha", "bravo"), available.getValue("pm"))
    }

    @Test
    fun aCustomSourceUpgradesItsItemsOneAtATime() {
        val manifest = manifestOf { root.outdated("pins", command = "list-pins", upgrade = "repin {item}") }
        val plan = engine().planSourceItems(manifest, "pins", listOf("golang", "nodejs"))
        assertEquals(listOf("repin golang", "repin nodejs"), plan.map { it.command })
        assertEquals(listOf(listOf("golang"), listOf("nodejs")), plan.map { it.covers })
    }

    @Test
    fun sudoDeclarationsPlanAsUsual() {
        val manifest = manifestOf {
            val pkg = root.installer("omarchy-pkg") {
                install = "omarchy pkg add {pkg}"
                upgrade = "omarchy update -y"
                check = "pacman -Q {pkg}"
                regex = "([0-9.]+)"
                needsSudo()
            }
            val zsh = root.program("zsh") { installVia(pkg) }
            machine("m") { install(zsh) }
            root.outdated("pins", command = "list-pins", upgrade = "repin {item}", needsSudo = true)
            root.outdated("plain", command = "list", upgrade = "bump {item}")
        }
        val step = engine().plan(manifest, "m", listOf("omarchy-pkg")).single()
        assertEquals("omarchy update -y", step.command)
        assertTrue(step.sudo)
        assertEquals("repin golang", engine().planSourceItems(manifest, "pins", listOf("golang")).single().command)
    }

    @Test
    fun aSourceWithNoUpgradeCommandIsRefused() {
        val manifest = manifestOf { root.outdated("pins", command = "list-pins") }
        val e = assertFailsWith<UpgradeException> {
            engine().planSourceItems(manifest, "pins", listOf("golang"))
        }
        assertTrue("declares no upgrade command" in e.message.orEmpty(), e.message.orEmpty())
    }
}
