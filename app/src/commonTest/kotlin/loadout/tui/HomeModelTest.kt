package loadout.tui

import loadout.core.manifest.ManifestLoader
import loadout.core.model.MachineState
import loadout.core.model.OsFamily
import loadout.core.model.ProgramState
import loadout.core.model.ProgramStatus
import loadout.core.model.ScriptState
import loadout.core.model.ScriptStatus
import loadout.core.model.SystemInfo
import loadout.theme.detectDarkTerminal
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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

    [scripts.bootstrap]
    run = "true"
    modes = ["setup"]

    [machines.m1]
    scripts = ["dotfiles", "bootstrap"]
    [machines.m1.pm]
    git = "dnf"
    kitty = "dnf"
    """.trimIndent(),
)

private val SYSTEM = SystemInfo("m1", OsFamily.LINUX, "fedora", "x86_64")

private fun update(name: String, current: String, candidate: String, source: String = "dnf") =
    loadout.cli.UpdateRow(name, current, candidate, source)

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
        assertEquals(HomeAction.RUN_SCRIPTS, scripts.action)
        assertEquals(false, scripts.severity)
        // Its detail is the picker (opens on l), so nothing spills on focus.
        assertTrue(scripts.offenders.isEmpty())
    }

    @Test
    fun settledSubjectsOfferNothing() {
        val sections = sectionsOf(MANIFEST, SYSTEM, state("dotfiles" to ScriptStatus.DONE), null, null)
        val scripts = sections.first { it.subject == "scripts" }
        // Settled, but still openable: ticking a done script is how you force it.
        assertEquals(HomeAction.RUN_SCRIPTS, scripts.action)
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
        HomeSection("programs", "", "install", HomeAction.INSTALL_MISSING),
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
    fun nothingFiresWhileAnAnswerIsStillComing() {
        // Enter used to dispatch `outdated` over the ask already running.
        val sections = listOf(HomeSection("remote", "", "review", HomeAction.REVIEW_OUTDATED, busy = true))
        val m = model(sections)
        assertEquals(false, m.handleKey(HomeKey.ENTER))
        assertEquals(HomeAction.NONE, m.state.action)
        assertEquals(false, m.state.exit)
        assertTrue(m.state.message!!.contains("still asking"))

        m.handleKey(HomeKey.OPEN)
        assertEquals(false, m.state.expanded)
    }

    @Test
    fun lookingIsLsJobAndEnterIsForActing() {
        val sections = listOf(HomeSection("remote", "", "review", HomeAction.REVIEW_OUTDATED))
        val m = model(sections)
        m.setStateForTest(
            HomeState(
                sections = sections,
                remote = RemoteStatus.Answered(listOf(update("kitty", "1", "2")), failedSources = 0),
            ),
        )
        // enter no longer opens: it says which key does.
        m.handleKey(HomeKey.ENTER)
        assertEquals(false, m.state.expanded)
        assertTrue(m.state.message!!.contains("press l"))

        m.handleKey(HomeKey.OPEN)
        assertTrue(m.state.expanded)
        // ...and h closes it, where enter would now upgrade.
        m.handleKey(HomeKey.CLOSE)
        assertEquals(false, m.state.expanded)
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
        assertEquals(HomeAction.INSTALL_MISSING, m.state.action)
        assertTrue(m.state.exit)
    }

    @Test
    fun lOpensAnAnsweredRemoteInPlace() {
        val m = model(listOf(HomeSection("remote", "", "review them", HomeAction.REVIEW_OUTDATED)))
        m.setStateForTest(
            HomeState(
                sections = listOf(HomeSection("remote", "", "review them", HomeAction.REVIEW_OUTDATED)),
                remote = RemoteStatus.Answered(listOf(update("kitty", "1", "2")), failedSources = 0),
            ),
        )
        // Already answered: the table shows here, it doesn't leave to ask again.
        m.handleKey(HomeKey.OPEN)
        assertTrue(m.state.expanded)
        assertEquals(HomeAction.NONE, m.state.action)
        assertEquals(false, m.state.exit)

        m.handleKey(HomeKey.CLOSE)
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
        m.handleKey(HomeKey.OPEN, viewport = 5)
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
        assertEquals(setOf("tool:pm"), m.state.selection)

        // enter is the upgrade key inside the table; it runs HERE, in the
        // floating pane, so the screen must not leave.
        assertEquals(false, m.handleKey(HomeKey.ENTER, viewport = 5))
        assertEquals(HomeAction.NONE, m.state.action)
        assertEquals(false, m.state.exit)
    }

    @Test
    fun thePaneAsksBeforeItRuns() {
        val sections = listOf(HomeSection("remote", "", "review", HomeAction.REVIEW_OUTDATED))
        val m = model(sections)
        m.setStateForTest(
            HomeState(
                sections = sections,
                run = PaneRun(
                    steps = listOf("pm"),
                    confirming = true,
                    commands = listOf("[pm]  pm upgrade -y"),
                ),
            ),
        )
        // esc on the question changes nothing at all.
        m.handleKey(HomeKey.ESC)
        assertEquals(null, m.state.run)
        assertEquals(false, m.state.exit)
    }

    @Test
    fun thePaneScrollsBackThroughItsOutput() {
        val sections = listOf(HomeSection("remote", "", "review", HomeAction.REVIEW_OUTDATED))
        val m = model(sections)
        m.setStateForTest(
            HomeState(
                sections = sections,
                run = PaneRun(steps = listOf("pm"), log = (1..30).map { "line $it" }),
            ),
        )
        m.handleKey(HomeKey.UP, viewport = 5)
        assertEquals(1, m.state.run!!.scrollBack, "0 follows the tail; 1 pins one line back")
        m.handleKey(HomeKey.PAGE_UP, viewport = 5)
        assertEquals(6, m.state.run!!.scrollBack)
        repeat(20) { m.handleKey(HomeKey.PAGE_UP, viewport = 5) }
        assertEquals(25, m.state.run!!.scrollBack, "stops at the top")
        repeat(20) { m.handleKey(HomeKey.PAGE_DOWN, viewport = 5) }
        assertEquals(0, m.state.run!!.scrollBack, "and back to following the tail")
    }

    @Test
    fun theFloatingPaneOwnsTheKeyboardWhileItRuns() {
        val sections = listOf(HomeSection("remote", "", "review", HomeAction.REVIEW_OUTDATED))
        val m = model(sections)
        m.setStateForTest(
            HomeState(sections = sections, run = PaneRun(steps = listOf("pm"), label = "pm")),
        )
        // Mid-run: q cancels the run, it does not quit the screen.
        m.handleKey(HomeKey.QUIT)
        assertEquals(false, m.state.exit)

        m.setStateForTest(
            HomeState(
                sections = sections,
                selection = setOf("pm"),
                run = PaneRun(steps = listOf("pm"), label = "pm", done = true, summary = "done"),
            ),
        )
        m.handleKey(HomeKey.ENTER)
        assertEquals(null, m.state.run, "enter closes a finished pane")
        assertTrue(m.state.selection.isEmpty(), "and clears what it just upgraded")
    }

    @Test
    fun aCustomSourcesRowsTickOneByOne() {
        // A pin in a file is nothing like a package manager's transaction:
        // these select individually.
        val sections = listOf(HomeSection("remote", "", "review", HomeAction.REVIEW_OUTDATED))
        val m = model(sections)
        val rows = listOf(
            update("golang", "a", "b", "asdf-plugins"),
            update("nodejs", "a", "b", "asdf-plugins"),
        )
        m.setStateForTest(
            HomeState(
                sections = sections,
                expanded = true,
                remote = RemoteStatus.Answered(
                    updates = rows,
                    failedSources = 0,
                    upgradableSources = setOf("asdf-plugins"),
                ),
            ),
        )
        m.handleKey(HomeKey.SELECT, viewport = 5)
        assertEquals(setOf("item:asdf-plugins/golang"), m.state.selection, "one row, not the source")
        m.handleKey(HomeKey.SELECT_ALL, viewport = 5)
        assertEquals(
            setOf("item:asdf-plugins/golang", "item:asdf-plugins/nodejs"),
            m.state.selection,
        )
    }

    @Test
    fun theSameNameInTwoSourcesIsTwoRows() {
        // python is an asdf TOOL and an asdf PLUGIN: ticking one must not
        // tick the other (selection keyed by row name used to do exactly that).
        val sections = listOf(HomeSection("remote", "", "review", HomeAction.REVIEW_OUTDATED))
        val m = model(sections)
        val rows = listOf(
            update("python", "3.14.1", "3.14.2", "asdf-tools"),
            update("python", "d4caa7d", "abc2a03", "asdf-plugins"),
        )
        m.setStateForTest(
            HomeState(
                sections = sections,
                expanded = true,
                remote = RemoteStatus.Answered(
                    updates = rows,
                    failedSources = 0,
                    upgradableSources = setOf("asdf-tools", "asdf-plugins"),
                ),
            ),
        )
        m.handleKey(HomeKey.SELECT, viewport = 5)
        assertEquals(setOf("item:asdf-tools/python"), m.state.selection)
        m.handleKey(HomeKey.DOWN, viewport = 5)
        m.handleKey(HomeKey.SELECT, viewport = 5)
        assertEquals(
            setOf("item:asdf-tools/python", "item:asdf-plugins/python"),
            m.state.selection,
        )
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
    fun theScriptsPickerListsMaintenanceScriptsWithTheirLastVerdicts() {
        val rows = scriptRowsOf(MANIFEST, SYSTEM, state("dotfiles" to ScriptStatus.PENDING))
        // bootstrap is modes=["setup"]: converge's, never the picker's.
        assertEquals(listOf("dotfiles"), rows.map { it.name })
        assertEquals(ScriptStatus.PENDING, rows.single().status)
        assertEquals("true", rows.single().command)
        // Never observed = unproven, not done — and so ticked.
        val unseen = scriptRowsOf(MANIFEST, SYSTEM, state())
        assertNull(unseen.single().status)
        assertEquals(setOf("dotfiles"), preselect(unseen))
        assertEquals(emptySet(), preselect(scriptRowsOf(MANIFEST, SYSTEM, state("dotfiles" to ScriptStatus.DONE))))
    }

    @Test
    fun theScriptsPickerTicksOneScriptAtATimeAndEnterRunsThemHere() {
        val sections = listOf(HomeSection("scripts", "", "run", HomeAction.RUN_SCRIPTS))
        val m = model(sections)
        val rows = listOf(
            ScriptRow("pull", "sh pull", status = ScriptStatus.PENDING),
            ScriptRow("apply", "sh apply", status = ScriptStatus.DONE),
        )
        m.setStateForTest(HomeState(sections = sections, scripts = rows, picked = setOf("pull")))
        // enter on the closed row looks, it doesn't run: l opens the picker.
        m.handleKey(HomeKey.ENTER)
        assertTrue(m.state.message!!.contains("press l"))
        m.handleKey(HomeKey.OPEN)
        assertTrue(m.state.expanded)

        // space on a done script ticks it: that is the force.
        m.handleKey(HomeKey.DOWN, viewport = 5)
        m.handleKey(HomeKey.SELECT, viewport = 5)
        assertEquals(setOf("pull", "apply"), m.state.picked)
        m.handleKey(HomeKey.SELECT_ALL, viewport = 5)
        assertEquals(emptySet(), m.state.picked, "a on a full tick clears it")
        m.handleKey(HomeKey.SELECT_ALL, viewport = 5)
        assertEquals(setOf("pull", "apply"), m.state.picked)

        // enter runs the picks HERE — the screen stays, the pane asks first.
        assertEquals(false, m.handleKey(HomeKey.ENTER, viewport = 5))
        assertEquals(false, m.state.exit)
        val run = m.state.run!!
        assertTrue(run.confirming)
        assertTrue(run.scripts)
        assertEquals(listOf("[pull]  sh pull", "[apply]  sh apply"), run.commands, "in run order, not tick order")

        // esc on the question leaves the picks alone for another go.
        m.handleKey(HomeKey.ESC, viewport = 5)
        assertNull(m.state.run)
        assertEquals(setOf("pull", "apply"), m.state.picked)
    }

    @Test
    fun enterWithNothingTickedSaysSo() {
        val sections = listOf(HomeSection("scripts", "", "run", HomeAction.RUN_SCRIPTS))
        val m = model(sections)
        m.setStateForTest(HomeState(sections = sections, expanded = true, scripts = listOf(ScriptRow("pull", "sh pull"))))
        assertEquals(false, m.handleKey(HomeKey.ENTER, viewport = 5))
        assertNull(m.state.run)
        assertTrue(m.state.message!!.contains("nothing ticked"))
    }

    @Test
    fun closingAScriptRunKeepsTheRemoteSelection() {
        val sections = listOf(HomeSection("scripts", "", "run", HomeAction.RUN_SCRIPTS))
        val m = model(sections)
        m.setStateForTest(
            HomeState(
                sections = sections,
                selection = setOf("tool:dnf"),
                run = PaneRun(steps = listOf("pull"), scripts = true, done = true, summary = "done"),
            ),
        )
        m.handleKey(HomeKey.ENTER)
        assertNull(m.state.run)
        assertEquals(setOf("tool:dnf"), m.state.selection, "only an upgrade's own picks are cleared")
    }

    @Test
    fun quitLeavesWithoutAnAction() {
        val m = model(sections, cursor = 1)
        m.handleKey(HomeKey.QUIT)
        assertTrue(m.state.exit)
        assertEquals(HomeAction.NONE, m.state.action)
    }
}

class ThemeDetectionTest {
    @Test
    fun oscLumaWinsOverColorFgBg() {
        assertEquals(true, detectDarkTerminal(0.08, null))
        assertEquals(false, detectDarkTerminal(0.93, "15;0"))
    }

    @Test
    fun colorFgBgFallbackAndUnknownDefaultsDark() {
        assertEquals(true, detectDarkTerminal(null, "15;0"))
        assertEquals(false, detectDarkTerminal(null, "0;15"))
        assertEquals(false, detectDarkTerminal(null, "0;7"))
        assertEquals(true, detectDarkTerminal(null, null))
        assertEquals(true, detectDarkTerminal(null, "garbage"))
        assertEquals(false, detectDarkTerminal(null, "12;default;15"))
    }
}

class DisplayLinesTest {
    @Test
    fun carriageReturnProgressCollapsesToFinalState() {
        assertEquals(listOf("progress 100%"), displayLines("progress 10%\rprogress 50%\rprogress 100%"))
    }

    @Test
    fun ansiEscapesAreStrippedAndTabsExpanded() {
        assertEquals(listOf("colored ok"), displayLines("\u001b[32mcolored ok\u001b[0m"))
        assertEquals(listOf("a    b    c"), displayLines("a\tb\tc"))
    }

    @Test
    fun embeddedNewlinesSplitAndBlanksDrop() {
        assertEquals(listOf("one", "two"), displayLines("one\n\ntwo\n"))
    }
}

class SudoGuardTest {
    @Test
    fun sudoIsMatchedAsAWordNotASubstring() {
        assertTrue(commandNeedsSudo("sudo dnf install -y git"))
        assertTrue(commandNeedsSudo("true && sudo systemctl enable x"))
        assertFalse(commandNeedsSudo("sh 'scripts/pseudo-tty.sh'"))
        assertFalse(commandNeedsSudo("echo sudoku"))
    }
}
