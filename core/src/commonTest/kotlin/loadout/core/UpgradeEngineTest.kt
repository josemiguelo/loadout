package loadout.core

import loadout.core.engine.UpgradeEngine
import loadout.core.engine.UpgradeException
import loadout.core.manifest.ManifestLoader
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

private val MANIFEST = ManifestLoader.parse(
    """
    [installers.pm]
    install = "install {pkg}"
    upgrade = "pm upgrade -y"
    check = "pm show {pkg}"
    regex = "([0-9.]+)"

    [installers.rolling]
    install = "roll {pkg}"
    upgrade = "roll -Syu"
    check = "roll -Q {pkg}"
    regex = "([0-9.]+)"

    [installers.manual]
    install = "by hand {pkg}"
    check = "true"
    regex = "([0-9.]+)"

    [programs.alpha]
    via = ["pm"]
    [programs.bravo]
    via = ["pm"]
    [programs.charlie]
    via = ["rolling"]
    [programs.delta]
    via = ["manual"]

    [machines.m1.pm]
    alpha = "pm"
    bravo = "pm"
    charlie = "rolling"
    delta = "manual"

    [machines.m2.pm]
    delta = "manual"
    """.trimIndent(),
)

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
        val manifest = ManifestLoader.parse(
            """
            [outdated.pins]
            command = "list-pins"
            upgrade = "repin {item}"
            """.trimIndent(),
        )
        val plan = engine().planSourceItems(manifest, "pins", listOf("golang", "nodejs"))
        assertEquals(listOf("repin golang", "repin nodejs"), plan.map { it.command })
        assertEquals(listOf(listOf("golang"), listOf("nodejs")), plan.map { it.covers })
    }

    @Test
    fun aSourceWithNoUpgradeCommandIsRefused() {
        val manifest = ManifestLoader.parse(
            """
            [outdated.pins]
            command = "list-pins"
            """.trimIndent(),
        )
        val e = assertFailsWith<UpgradeException> {
            engine().planSourceItems(manifest, "pins", listOf("golang"))
        }
        assertTrue("declares no upgrade command" in e.message.orEmpty(), e.message.orEmpty())
    }
}
