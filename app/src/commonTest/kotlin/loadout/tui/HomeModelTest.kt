package loadout.tui

import loadout.core.manifest.ManifestLoader
import loadout.core.model.MachineState
import loadout.core.model.OsFamily
import loadout.core.model.ProgramState
import loadout.core.model.ProgramStatus
import loadout.core.model.ScriptState
import loadout.core.model.ScriptStatus
import loadout.core.model.SystemInfo
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val MANIFEST = ManifestLoader.parse(
    """
    [programs.git]
    via = ["dnf"]
    [programs.kitty]
    via = ["dnf"]

    [scripts.dotfiles]
    run = "true"
    check = "true"

    [machines.m1.pm]
    git = "dnf"
    kitty = "dnf"
    """.trimIndent(),
)

private val SYSTEM = SystemInfo("m1", OsFamily.LINUX, "fedora", "x86_64")

private fun update(name: String, current: String, candidate: String) =
    loadout.cli.UpdateRow(name, current, candidate, "dnf")

private fun state(vararg scripts: Pair<String, ScriptStatus>) = MachineState(
    machine = "m1",
    os = "linux",
    distro = "fedora",
    arch = "x86_64",
    toolVersion = "0.0.0",
    updatedAt = "now",
    programs = mapOf(
        "git" to ProgramState(ProgramStatus.INSTALLED, "2.55.0"),
        "kitty" to ProgramState(ProgramStatus.MISSING),
    ),
    scripts = scripts.associate { (name, status) -> name to ScriptState(status) },
)

class HomeSectionsTest {
    @Test
    fun eachSubjectOffersTheVerbThatResolvesIt() {
        val sections = sectionsOf(MANIFEST, SYSTEM, state("dotfiles" to ScriptStatus.PENDING), null, null)
        assertEquals(listOf("programs", "scripts", "remote", "fleet"), sections.map { it.subject })

        val programs = sections.first { it.subject == "programs" }
        assertEquals(HomeAction.INSTALL_MISSING, programs.action)
        assertEquals(listOf("kitty"), programs.offenders)
        assertEquals(true, programs.severity)

        val scripts = sections.first { it.subject == "scripts" }
        assertEquals(HomeAction.RUN_PENDING, scripts.action)
        assertEquals(listOf("dotfiles"), scripts.offenders)
    }

    @Test
    fun settledSubjectsOfferNothing() {
        val sections = sectionsOf(MANIFEST, SYSTEM, state("dotfiles" to ScriptStatus.DONE), null, null)
        val scripts = sections.first { it.subject == "scripts" }
        assertEquals(HomeAction.NONE, scripts.action)
        assertNull(scripts.severity)
        assertTrue(scripts.offenders.isEmpty())
        // No state files to compare: the fleet row can't act either.
        val fleet = sections.first { it.subject == "fleet" }
        assertEquals(HomeAction.NONE, fleet.action)
        // Its detail opens on enter, so nothing spills under the cursor.
        assertTrue(fleet.offenders.isEmpty())
    }

    @Test
    fun theRemoteRowFollowsTheAnswerAsItArrives() {
        fun remote(status: RemoteStatus?) =
            sectionsOf(MANIFEST, SYSTEM, state(), null, status).first { it.subject == "remote" }

        // Unknown until answered — never a green tick for "haven't asked".
        assertTrue(remote(null).neutral)
        assertTrue(remote(RemoteStatus.Asking).neutral)
        assertTrue(remote(RemoteStatus.Unavailable("offline")).neutral)

        val answered = remote(
            RemoteStatus.Answered(
                listOf(update("kitty", "0.48.2", "0.49.0"), update("loadout", "0.9.1", "0.9.2")),
                failedSources = 0,
            ),
        )
        assertEquals("2 update(s) available", answered.summary)
        assertEquals(false, answered.severity)
        // The names are NOT spilled under the row on focus: enter opens the
        // table instead, so moving the cursor stays quiet.
        assertTrue(answered.offenders.isEmpty())

        val clean = remote(RemoteStatus.Answered(emptyList(), failedSources = 0))
        assertEquals("everything up to date", clean.summary)
        assertNull(clean.severity)

        // A broken oracle is worse than an outdated package: it hides them.
        val broken = remote(RemoteStatus.Answered(listOf(update("kitty", "1", "2")), failedSources = 1))
        assertEquals(true, broken.severity)
    }
}

class HomeKeysTest {
    private fun model(sections: List<HomeSection>, cursor: Int = 0): HomeModel {
        // No AppContext work: the reducer is pure over state.
        val m = HomeModel(loadout.cli.AppContext("/repo".let { okio.Path.Companion.run { it.toPath() } }, "manifest.toml", null, false))
        m.setStateForTest(HomeState(sections = sections, cursor = cursor))
        return m
    }

    private val sections = listOf(
        HomeSection("programs", "", "", HomeAction.NONE),
        HomeSection("scripts", "", "", HomeAction.RUN_PENDING),
    )

    @Test
    fun navigationStaysInsideTheList() {
        val m = model(sections)
        m.handleKey(HomeKey.UP)
        assertEquals(0, m.state.cursor)
        m.handleKey(HomeKey.DOWN)
        m.handleKey(HomeKey.DOWN)
        assertEquals(1, m.state.cursor)
    }

    @Test
    fun enterActsOnTheFocusedLineOnly() {
        val m = model(sections)
        // A settled subject has no verb: enter says so instead of exiting.
        assertEquals(false, m.handleKey(HomeKey.ENTER))
        assertEquals(HomeAction.NONE, m.state.action)
        assertEquals(false, m.state.exit)

        m.handleKey(HomeKey.DOWN)
        assertEquals(true, m.handleKey(HomeKey.ENTER))
        assertEquals(HomeAction.RUN_PENDING, m.state.action)
        assertTrue(m.state.exit)
    }

    @Test
    fun enterOnAnAnsweredRemoteOpensItInPlace() {
        val m = model(listOf(HomeSection("remote", "", "review them", HomeAction.REVIEW_OUTDATED)))
        m.setStateForTest(
            HomeState(
                sections = listOf(HomeSection("remote", "", "review them", HomeAction.REVIEW_OUTDATED)),
                remote = RemoteStatus.Answered(listOf(update("kitty", "1", "2")), failedSources = 0),
            ),
        )
        // Already answered: enter shows the table here, it doesn't leave to ask again.
        assertEquals(false, m.handleKey(HomeKey.ENTER))
        assertTrue(m.state.expanded)
        assertEquals(HomeAction.NONE, m.state.action)
        assertEquals(false, m.state.exit)

        assertEquals(false, m.handleKey(HomeKey.ENTER))
        assertEquals(false, m.state.expanded)
    }

    @Test
    fun enterOnAnUnansweredRemoteStillDispatches() {
        val sections = listOf(HomeSection("remote", "", "review them", HomeAction.REVIEW_OUTDATED))
        val m = model(sections)
        m.setStateForTest(HomeState(sections = sections, remote = RemoteStatus.Unavailable("offline")))
        assertEquals(true, m.handleKey(HomeKey.ENTER))
        assertEquals(HomeAction.REVIEW_OUTDATED, m.state.action)
    }

    @Test
    fun anOpenDetailTakesTheArrowsAndStaysInBounds() {
        val sections = listOf(HomeSection("remote", "", "review them", HomeAction.REVIEW_OUTDATED))
        val m = model(sections)
        val updates = (1..20).map { update("pkg$it", "1", "2") }
        m.setStateForTest(
            HomeState(sections = sections, remote = RemoteStatus.Answered(updates, failedSources = 0)),
        )
        m.handleKey(HomeKey.ENTER, viewport = 5)
        assertTrue(m.state.expanded)

        // The arrows move the focused LINE; the window follows it.
        m.handleKey(HomeKey.DOWN, viewport = 5)
        assertEquals(1, m.state.detailCursor)
        assertEquals(0, m.state.scroll, "no need to scroll while the line is visible")
        assertEquals(0, m.state.cursor, "arrows belong to the detail, not the section list")

        m.handleKey(HomeKey.PAGE_DOWN, viewport = 5)
        assertEquals(6, m.state.detailCursor)
        assertEquals(2, m.state.scroll)

        repeat(20) { m.handleKey(HomeKey.PAGE_DOWN, viewport = 5) }
        assertEquals(19, m.state.detailCursor, "the last line stops at the end")
        assertEquals(15, m.state.scroll)

        repeat(30) { m.handleKey(HomeKey.UP, viewport = 5) }
        assertEquals(0, m.state.detailCursor)
        assertEquals(0, m.state.scroll)

        m.handleKey(HomeKey.ESC, viewport = 5)
        assertEquals(false, m.state.expanded)
        assertEquals(false, m.state.exit, "esc closes the detail before it quits the screen")
    }

    @Test
    fun lOpensAndHClosesWithoutActing() {
        val sections = listOf(
            HomeSection("programs", "", "install", HomeAction.INSTALL_MISSING),
            HomeSection("remote", "", "review them", HomeAction.REVIEW_OUTDATED),
        )
        val m = model(sections)
        m.setStateForTest(
            HomeState(
                sections = sections,
                cursor = 1,
                remote = RemoteStatus.Answered(listOf(update("kitty", "1", "2")), failedSources = 0),
            ),
        )
        m.handleKey(HomeKey.OPEN)
        assertTrue(m.state.expanded)
        m.handleKey(HomeKey.CLOSE)
        assertEquals(false, m.state.expanded)

        // `l` never acts: a row with no detail says so instead of dispatching.
        m.setStateForTest(HomeState(sections = sections, cursor = 0))
        m.handleKey(HomeKey.OPEN)
        assertEquals(false, m.state.expanded)
        assertEquals(false, m.state.exit)
        assertEquals(HomeAction.NONE, m.state.action)
        assertTrue(m.state.message!!.contains("nothing to open"))
    }

    @Test
    fun machineWideVerbsHaveTheirOwnKeys() {
        val sections = listOf(HomeSection("programs", "", "install", HomeAction.INSTALL_MISSING))
        for ((key, action) in listOf(
            HomeKey.SYNC to HomeAction.SYNC,
            HomeKey.UPGRADE to HomeAction.UPGRADE,
            HomeKey.CONVERGE to HomeAction.SETUP,
        )) {
            val m = model(sections)
            assertEquals(true, m.handleKey(key), "$key should leave the screen")
            assertEquals(action, m.state.action)
            assertTrue(m.state.exit)
        }
    }

    @Test
    fun machineWideVerbsWorkWithADetailOpen() {
        val sections = listOf(HomeSection("remote", "", "review", HomeAction.REVIEW_OUTDATED))
        val m = model(sections)
        m.setStateForTest(
            HomeState(
                sections = sections,
                expanded = true,
                remote = RemoteStatus.Answered(listOf(update("kitty", "1", "2")), failedSources = 0),
            ),
        )
        assertEquals(true, m.handleKey(HomeKey.SYNC))
        assertEquals(HomeAction.SYNC, m.state.action)
    }

    @Test
    fun selectingAPackageSelectsItsWholeMechanism() {
        val sections = listOf(HomeSection("remote", "", "review", HomeAction.REVIEW_OUTDATED))
        val m = model(sections)
        val rows = listOf(update("alpha", "1", "2"), update("bravo", "1", "2"), update("oracle", "a", "b"))
        m.setStateForTest(
            HomeState(
                sections = sections,
                expanded = true,
                remote = RemoteStatus.Answered(
                    updates = rows,
                    failedSources = 0,
                    mechanismOf = mapOf("alpha" to "pm", "bravo" to "pm"),
                    toolOf = mapOf("pm" to "pm"),
                    mechanismsOfTool = mapOf("pm" to listOf("pm")),
                ),
            ),
        )
        // One key, one mechanism — loadout never upgrades a single package.
        m.handleKey(HomeKey.SELECT, viewport = 5)
        assertEquals(setOf("pm"), m.state.selection)

        // u runs it HERE (floating pane), so the screen must not leave.
        assertEquals(false, m.handleKey(HomeKey.UPGRADE_SELECTION, viewport = 5))
        assertEquals(HomeAction.NONE, m.state.action)
        assertEquals(false, m.state.exit)
    }

    @Test
    fun theFloatingPaneOwnsTheKeyboardWhileItRuns() {
        val sections = listOf(HomeSection("remote", "", "review", HomeAction.REVIEW_OUTDATED))
        val m = model(sections)
        m.setStateForTest(
            HomeState(sections = sections, run = UpgradeRun(steps = listOf("pm"), label = "pm")),
        )
        // Mid-run: q cancels the run, it does not quit the screen.
        m.handleKey(HomeKey.QUIT)
        assertEquals(false, m.state.exit)

        m.setStateForTest(
            HomeState(
                sections = sections,
                selection = setOf("pm"),
                run = UpgradeRun(steps = listOf("pm"), label = "pm", done = true, summary = "done"),
            ),
        )
        m.handleKey(HomeKey.ENTER)
        assertEquals(null, m.state.run, "enter closes a finished pane")
        assertTrue(m.state.selection.isEmpty(), "and clears what it just upgraded")
    }

    @Test
    fun aRowWithNoMechanismSaysSoInsteadOfTicking() {
        val sections = listOf(HomeSection("remote", "", "review", HomeAction.REVIEW_OUTDATED))
        val m = model(sections)
        m.setStateForTest(
            HomeState(
                sections = sections,
                expanded = true,
                remote = RemoteStatus.Answered(listOf(update("oracle", "a", "b")), failedSources = 0),
            ),
        )
        m.handleKey(HomeKey.SELECT, viewport = 5)
        assertTrue(m.state.selection.isEmpty())
        assertTrue(m.state.message!!.contains("no mechanism"))
    }

    @Test
    fun quitLeavesWithoutAnAction() {
        val m = model(sections, cursor = 1)
        m.handleKey(HomeKey.QUIT)
        assertTrue(m.state.exit)
        assertEquals(HomeAction.NONE, m.state.action)
    }
}
