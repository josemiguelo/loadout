package loadout.tui

import loadout.core.manifest.ManifestLoader
import loadout.core.model.MachineState
import loadout.core.model.OsFamily
import loadout.core.model.ProgramState
import loadout.core.model.ProgramStatus
import loadout.core.model.ScriptState
import loadout.core.model.ScriptStatus
import loadout.core.model.SystemInfo
import loadout.theme.ThemeException
import loadout.theme.detectDarkTerminal
import loadout.theme.forcedDark
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
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
        assertEquals(true, programs.severity)

        val scripts = sections.first { it.subject == "scripts" }
        assertEquals(HomeAction.RUN_SCRIPTS, scripts.action)
        assertEquals(false, scripts.severity)
    }

    @Test
    fun settledSubjectsOfferNothing() {
        val sections = sectionsOf(MANIFEST, SYSTEM, state("dotfiles" to ScriptStatus.DONE), null, null)
        val scripts = sections.first { it.subject == "scripts" }
        // Settled, but still openable: ticking a done script is how you force it.
        assertEquals(HomeAction.RUN_SCRIPTS, scripts.action)
        assertNull(scripts.severity)
        // No state files to compare: the fleet row can't act either.
        val fleet = sections.first { it.subject == "fleet" }
        assertEquals(HomeAction.NONE, fleet.action)
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
        assertEquals("2 updates · dnf 2", answered.summary)
        assertEquals(false, answered.severity)

        val clean = remote(RemoteStatus.Answered(emptyList(), failedSources = 0))
        assertEquals("everything up to date", clean.summary)
        assertNull(clean.severity)

        // A broken oracle is worse than an outdated package: it hides them.
        val broken = remote(RemoteStatus.Answered(listOf(update("kitty", "1", "2")), failedSources = 1))
        assertEquals(true, broken.severity)
    }
}

/**
 * The remote row's line answers "where is the work", so a tool with none is
 * not news — the live mac shipped "brew 0 · 42 pins", naming the only thing
 * with nothing to do and leaving the 42 that did anonymous.
 */
class RemoteSummaryTest {
    /** The live repo's shape: brew, plus five custom sources. */
    private fun answered(
        brew: Int? = 0,
        failedSources: Int = 0,
        counts: Map<String, Int> = mapOf(
            "nvim-plugins" to 15,
            "asdf-tools" to 10,
            "antidote-plugins" to 9,
            "asdf-plugins" to 7,
            "antidote" to 1,
        ),
    ) = RemoteStatus.Answered(
        updates = counts.flatMap { (source, n) ->
            (1..n).map { loadout.cli.UpdateRow("item$it", "1", "2", source) }
        },
        failedSources = failedSources,
        tools = listOf(
            loadout.cli.ToolUpdates("brew", listOf("brew"), total = brew, declared = emptyList(), others = emptyList(), command = "brew upgrade"),
        ),
        sources = counts.keys.associateWith { true },
    )

    @Test
    fun anIdleToolIsLeftOutAndTheWorkIsNamed() {
        val line = remoteSummary(answered(brew = 0))
        assertEquals("42 updates · nvim-plugins 15 · +4 more", line)
        assertFalse("brew" in line, "a tool with nothing outdated is not news")
        assertTrue(line.length <= SUMMARY_WIDTH)
    }

    @Test
    fun aToolWithWorkLeadsAndItsCountStaysItsOwn() {
        // One keystroke fixes brew's 3; the other 42 are 42 decisions. A
        // single "45 behind" would say they're the same kind of work, and
        // ranking brew purely by size would bury the cheapest win.
        val line = remoteSummary(answered(brew = 3))
        assertEquals("brew 3 · 42 more · nvim-plugins 15", line)
        assertTrue(line.length <= SUMMARY_WIDTH)
    }

    @Test
    fun nothingOutdatedReadsAsSettledEvenWhileToolsExist() {
        assertEquals(
            "everything up to date",
            remoteSummary(answered(brew = 0, counts = emptyMap())),
        )
    }

    @Test
    fun aCrashedSourceOutranksTheGroupNames() {
        // It's the one item here that means the rest of the line understates
        // the work, so it must survive the width, plural and all.
        val one = remoteSummary(answered(failedSources = 1))
        assertEquals("42 updates · 1 source failed", one)
        assertTrue("2 sources failed" in remoteSummary(answered(failedSources = 2)))
    }

    @Test
    fun anUnaskableToolKeepsAskingRatherThanReadingAsClean() {
        // No batch oracle can say — which is not the same as "nothing to do".
        assertTrue(remoteSummary(answered(brew = null)).startsWith("brew ?"))
    }

    @Test
    fun theBinaryOwnRowIsCalledLoadoutNotItsChannel() {
        val line = remoteSummary(
            RemoteStatus.Answered(
                updates = listOf(loadout.cli.UpdateRow("loadout", "0.12.0", "0.13.0", "release")),
                failedSources = 0,
            ),
        )
        assertEquals("1 update · loadout 1", line)
    }

    @Test
    fun longSourceNamesLoseTheMarkerNotTheColumn() {
        val line = remoteSummary(
            answered(counts = mapOf("some-very-long-source-name" to 3, "another-long-one" to 2)),
        )
        assertTrue(line.length <= SUMMARY_WIDTH, "spilling the column clips mid-word: $line")
        assertEquals("5 updates · some-very-long-source-name 3", line)
    }
}

class HomeKeysTest {
    private fun model(sections: List<HomeSection>, cursor: Int = 0): HomeModel {
        // No AppContext work: the reducer is pure over state.
        val m = HomeModel(loadout.cli.AppContext("/repo".let { okio.Path.Companion.run { it.toPath() } }, "manifest.toml", null, false))
        m.setStateForTest(HomeState(sections = sections, cursor = cursor))
        return m
    }

    /** Drop the cursor on the first stop inside [section]'s open detail. */
    private fun HomeModel.intoDetail(section: Int = 0) {
        val first = homeLines(state)
            .indexOfFirst { it is HomeLine.Detail && it.section == section && it.focusable }
        setStateForTest(state.copy(cursor = first))
    }

    /** The detail row the cursor is on, or -1 when it's on a subject row. */
    private val HomeModel.detailRow: Int
        get() {
            val lines = homeLines(state)
            return (lines.getOrNull(snapCursor(lines, state.cursor)) as? HomeLine.Detail)?.index ?: -1
        }

    /** The subject the cursor's line belongs to. */
    private val HomeModel.focusedSection: Int
        get() {
            val lines = homeLines(state)
            return lines[snapCursor(lines, state.cursor)].section
        }

    /** The remote line the cursor is on, whatever the body around it looks like. */
    private val HomeModel.remoteRow: RemoteLine?
        get() = (state.remote as? RemoteStatus.Answered)
            ?.let { remoteLines(it, state.collapsed).getOrNull(detailRow) }

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
        assertTrue(m.state.open.isEmpty())
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
        assertTrue(m.state.open.isEmpty())
        assertTrue(m.state.message!!.contains("press l"))

        m.handleKey(HomeKey.OPEN)
        assertEquals(setOf(HomeAction.REVIEW_OUTDATED), m.state.open)
        assertEquals(0, m.detailRow, "l opens onto the table's first row")
        // ...and h closes it, where enter would now upgrade — the first h
        // folds the group under the cursor, the second leaves the section.
        m.handleKey(HomeKey.CLOSE)
        assertEquals(setOf(HomeAction.REVIEW_OUTDATED), m.state.open)
        m.handleKey(HomeKey.CLOSE)
        assertTrue(m.state.open.isEmpty())
        assertEquals(-1, m.detailRow, "and the cursor comes out onto the subject row")
    }

    @Test
    fun enterNeverLeavesForARow() {
        val m = model(sections)
        // A settled subject has no verb: enter says so instead of exiting.
        assertEquals(false, m.handleKey(HomeKey.ENTER))
        assertEquals(HomeAction.NONE, m.state.action)
        assertEquals(false, m.state.exit)

        // A row with work opens its picker on l; enter points there.
        m.handleKey(HomeKey.DOWN)
        assertEquals(false, m.handleKey(HomeKey.ENTER))
        assertEquals(false, m.state.exit)
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
        assertEquals(setOf(HomeAction.REVIEW_OUTDATED), m.state.open)
        assertEquals(HomeAction.NONE, m.state.action)
        assertEquals(false, m.state.exit)

        // esc never folds — it closes the detail the cursor is in.
        m.handleKey(HomeKey.ESC)
        assertTrue(m.state.open.isEmpty())
        assertEquals(false, m.state.exit)
    }

    @Test
    fun noRowEverLeavesTheScreen() {
        // An unanswered remote used to exit into `outdated`, which would fail
        // the same way; a fleet in sync exited into `diff` to print "in sync";
        // programs exited into `install --all`. Only S/U/C leave now.
        val sections = listOf(
            HomeSection("remote", "", "review them", HomeAction.REVIEW_OUTDATED),
            HomeSection("fleet", "", "compare", HomeAction.SHOW_DIFF),
            HomeSection("programs", "", "install", HomeAction.INSTALL_MISSING),
        )
        val m = model(sections)
        m.setStateForTest(
            HomeState(
                sections = sections,
                remote = RemoteStatus.Unavailable("offline"),
                missing = listOf(ProgramRow("kitty", "dnf", "sudo dnf install -y kitty")),
            ),
        )
        assertEquals(false, m.handleKey(HomeKey.ENTER))
        assertEquals(false, m.state.exit)
        assertTrue(m.state.message!!.contains("r tries again"))

        m.handleKey(HomeKey.DOWN)
        assertEquals(false, m.handleKey(HomeKey.ENTER))
        assertTrue(m.state.message!!.contains("in sync"))

        m.handleKey(HomeKey.DOWN)
        assertEquals(false, m.handleKey(HomeKey.ENTER), "the picker opens on l; enter looks")
        assertTrue(m.state.message!!.contains("press l"))
        m.handleKey(HomeKey.OPEN)
        assertEquals(setOf(HomeAction.INSTALL_MISSING), m.state.open)
        assertEquals(HomeAction.NONE, m.state.action)
    }

    @Test
    fun thePaneAsksForTheSudoPasswordItself() {
        val sections = listOf(HomeSection("programs", "", "install", HomeAction.INSTALL_MISSING))
        val m = model(sections)
        m.setStateForTest(
            HomeState(
                sections = sections,
                run = PaneRun(steps = listOf("kitty"), kind = PaneKind.INSTALL, needsSudo = true, confirming = true, password = ""),
            ),
        )
        // Printable keys build the field; nothing else reacts to them.
        assertTrue(m.passwordKey("s"))
        assertTrue(m.passwordKey("3"))
        assertTrue(m.passwordKey("!"))
        assertEquals("s3!", m.state.run!!.password)
        assertTrue(m.passwordKey("Backspace"))
        assertEquals("s3", m.state.run!!.password)
        assertEquals(false, m.passwordKey("ArrowUp"), "non-printables fall through to the reducer")
        // j/q/h are letters now, not keys: the reducer never sees them.
        m.handleKey(HomeKey.QUIT)
        assertEquals(false, m.state.exit)
        assertTrue(m.state.run!!.confirming)
        // esc backs out to the question with nothing run and nothing kept.
        m.handleKey(HomeKey.ESC)
        assertNull(m.state.run!!.password)
        assertTrue(m.state.run!!.confirming)
    }

    @Test
    fun aDeclaredSudoMakesThePaneAskEvenWhenNoCommandSaysSudo() {
        // setup-brew hung here: Homebrew's installer prompted for sudo from
        // behind the pane, because nothing in `sh setup-brew.sh` says sudo.
        val sections = listOf(HomeSection("scripts", "", "run", HomeAction.RUN_SCRIPTS))
        val m = model(sections)
        val rows = listOf(ScriptRow("brew", "sh setup-brew.sh", sudo = true), ScriptRow("pull", "sh pull"))
        m.setStateForTest(HomeState(sections = sections, scripts = rows))
        m.startScripts(setOf("brew"))
        assertEquals(true, m.state.run!!.needsSudo, "declared")
        m.setStateForTest(HomeState(sections = sections, scripts = rows))
        m.startScripts(setOf("pull"))
        assertEquals(false, m.state.run!!.needsSudo, "neither said nor declared")
    }

    @Test
    fun theScriptsRowCarriesASudoDeclarationFromTheManifest() {
        val manifest = ManifestLoader.parse(
            """
            [scripts.hid]
            run = "true"
            sudo = true

            [scripts.plain]
            run = "true"

            [machines.m1]
            scripts = ["hid", "plain"]
            """.trimIndent(),
        )
        val rows = scriptRowsOf(manifest, SYSTEM, null).associate { it.name to it.sudo }
        assertEquals(mapOf("hid" to true, "plain" to false), rows)
    }

    @Test
    fun theProgramsPickerTicksAndAsksBeforeInstalling() {
        val rows = missingRowsOf(MANIFEST, SYSTEM, state())
        // kitty is missing in the fixture state, git is installed.
        assertEquals(listOf("kitty"), rows.map { it.name })
        assertEquals("dnf", rows.single().installKey)
        assertEquals("sudo dnf install -y kitty", rows.single().command)

        val sections = listOf(HomeSection("programs", "", "install", HomeAction.INSTALL_MISSING))
        val m = model(sections)
        m.setStateForTest(
            HomeState(sections = sections, open = setOf(HomeAction.INSTALL_MISSING), missing = rows, chosen = setOf("kitty")),
        )
        m.intoDetail()
        m.handleKey(HomeKey.SELECT, viewport = 5)
        assertEquals(emptySet(), m.state.chosen)
        assertEquals(false, m.handleKey(HomeKey.ENTER, viewport = 5))
        assertNull(m.state.run)
        assertTrue(m.state.message!!.contains("nothing ticked"))
        m.handleKey(HomeKey.SELECT_ALL, viewport = 5)
        assertEquals(setOf("kitty"), m.state.chosen)
    }

    /**
     * The arrows walk the WHOLE screen: an open table is passed through, not
     * locked into. Pressing k at its first row used to stop dead there, and
     * the only way to another subject was to close the table first.
     */
    @Test
    fun theArrowsWalkOutOfAnOpenTableAndLeaveItOpen() {
        val sections = listOf(
            HomeSection("scripts", "", "run", HomeAction.RUN_SCRIPTS),
            HomeSection("remote", "", "review them", HomeAction.REVIEW_OUTDATED),
        )
        val m = model(sections)
        val updates = (1..20).map { update("pkg$it", "1", "2") }
        m.setStateForTest(
            HomeState(
                sections = sections,
                cursor = 1,
                scripts = listOf(ScriptRow("pull", "sh pull")),
                remote = RemoteStatus.Answered(updates, failedSources = 0),
            ),
        )
        m.handleKey(HomeKey.OPEN, viewport = 5)
        assertEquals(setOf(HomeAction.REVIEW_OUTDATED), m.state.open)
        // 21 detail lines: the rows' source heading (a stop: space ticks all
        // of them), then the 20 rows. l opens onto the first.
        assertEquals(0, m.detailRow)
        assertEquals(2, m.state.cursor, "two subject rows come first")

        // The arrows move one stop at a time; the window follows them.
        m.handleKey(HomeKey.DOWN, viewport = 5)
        assertEquals(1, m.detailRow)
        assertEquals(0, m.state.scroll, "no need to scroll while the line is visible")

        m.handleKey(HomeKey.PAGE_DOWN, viewport = 5)
        assertEquals(6, m.detailRow)
        assertEquals(4, m.state.scroll)

        repeat(20) { m.handleKey(HomeKey.PAGE_DOWN, viewport = 5) }
        assertEquals(20, m.detailRow, "the last row stops at the end")
        assertEquals(18, m.state.scroll)

        // Up and out: the table's first row, then the subject it belongs to,
        // then the subject above — all with the table still open.
        repeat(21) { m.handleKey(HomeKey.UP, viewport = 5) }
        assertEquals(-1, m.detailRow, "k off the top row lands on the subject row")
        assertEquals(1, m.state.cursor)
        assertEquals(setOf(HomeAction.REVIEW_OUTDATED), m.state.open, "moving away closes nothing")

        m.handleKey(HomeKey.UP, viewport = 5)
        assertEquals(0, m.state.cursor, "and keeps going to the subject above")
        assertEquals(0, m.state.scroll)
        m.handleKey(HomeKey.UP, viewport = 5)
        assertEquals(0, m.state.cursor, "the first line of the screen is the end of the road")

        // From up here the other subject opens too, and both stay open.
        m.handleKey(HomeKey.OPEN, viewport = 5)
        assertEquals(setOf(HomeAction.RUN_SCRIPTS, HomeAction.REVIEW_OUTDATED), m.state.open)
        assertEquals(
            listOf("Subject", "Detail", "Subject", "Detail"),
            homeLines(m.state).take(4).map { it::class.simpleName },
            "the scripts picker and the remote table are both in the body",
        )
    }

    /**
     * `[`/`]` go over the rows to what heads them — the next group in the
     * remote table, then the next subject row. Paging through 40 rows to
     * reach the group below is the thing they replace.
     */
    @Test
    fun bracketsJumpBetweenHeadingsNotRows() {
        val sections = listOf(
            HomeSection("remote", "", "review", HomeAction.REVIEW_OUTDATED),
            HomeSection("fleet", "", "compare", HomeAction.SHOW_DIFF),
        )
        val m = model(sections)
        // dnf with two rows of its own, a clean flatpak, then a source.
        val answered = RemoteStatus.Answered(
            updates = listOf(update("kitty", "1", "2"), update("bat", "1", "2"), update("ruby", "a", "b", "asdf-tools")),
            failedSources = 0,
            tools = listOf(
                loadout.cli.ToolUpdates("dnf", listOf("dnf"), total = 2, declared = listOf("kitty", "bat"), others = emptyList(), command = "sudo dnf upgrade -y"),
                loadout.cli.ToolUpdates("flatpak", listOf("flatpak"), total = 0, declared = emptyList(), others = emptyList(), command = "flatpak --user update -y"),
            ),
            mechanismOf = mapOf("kitty" to "dnf", "bat" to "dnf"),
            toolOf = mapOf("dnf" to "dnf", "flatpak" to "flatpak"),
            mechanismsOfTool = mapOf("dnf" to listOf("dnf"), "flatpak" to listOf("flatpak")),
            sources = mapOf("asdf-tools" to true),
        )
        m.setStateForTest(HomeState(sections = sections, remote = answered))
        m.handleKey(HomeKey.OPEN, viewport = 20)
        assertEquals(0, m.detailRow, "the dnf heading")

        m.handleKey(HomeKey.NEXT_HEADING, viewport = 20)
        assertTrue(m.remoteRow is RemoteLine.Tool, "] skipped dnf's own rows to the next tool")
        assertEquals("tool:flatpak", m.remoteRow!!.group)
        m.handleKey(HomeKey.NEXT_HEADING, viewport = 20)
        assertTrue(m.remoteRow is RemoteLine.Source, "and then the source's heading")

        // Out of the table's groups: the next heading is the subject below.
        m.handleKey(HomeKey.NEXT_HEADING, viewport = 20)
        assertEquals(-1, m.detailRow)
        assertEquals(1, m.focusedSection, "the fleet row, below the whole table")
        val bottom = m.state.cursor
        m.handleKey(HomeKey.NEXT_HEADING, viewport = 20)
        assertEquals(bottom, m.state.cursor, "nothing below: the cursor stays put")

        // And back up through the same stops.
        m.handleKey(HomeKey.PREV_HEADING, viewport = 20)
        assertTrue(m.remoteRow is RemoteLine.Source)
        repeat(3) { m.handleKey(HomeKey.PREV_HEADING, viewport = 20) }
        assertEquals(0, m.state.cursor, "the remote row itself, above its table")
        assertEquals(setOf(HomeAction.REVIEW_OUTDATED), m.state.open, "jumping closes nothing")
    }

    /**
     * Closing a table to read another row shouldn't cost your place in it:
     * reopening lands on the line you left, and on the last one when the
     * table has since lost rows.
     */
    @Test
    fun reopeningATableLandsOnTheRowYouLeftIt() {
        val sections = listOf(HomeSection("scripts", "", "run", HomeAction.RUN_SCRIPTS))
        val m = model(sections)
        val scripts = (1..6).map { ScriptRow("s$it", "sh s$it") }
        m.setStateForTest(HomeState(sections = sections, scripts = scripts))

        m.handleKey(HomeKey.OPEN, viewport = 5)
        repeat(3) { m.handleKey(HomeKey.DOWN, viewport = 5) }
        assertEquals(3, m.detailRow)

        m.handleKey(HomeKey.CLOSE, viewport = 5)
        assertEquals(-1, m.detailRow, "h comes out onto the subject row")
        m.handleKey(HomeKey.OPEN, viewport = 5)
        assertEquals(3, m.detailRow, "and l goes back to the row it was on")

        // A re-check ran the last three: the row that was focused is gone,
        // so the cursor lands on the last one there is.
        m.handleKey(HomeKey.CLOSE, viewport = 5)
        m.setStateForTest(m.state.copy(scripts = scripts.take(2)))
        m.handleKey(HomeKey.OPEN, viewport = 5)
        assertEquals(1, m.detailRow, "the remembered row is past the end now")
    }

    @Test
    fun escClosesOnlyTheDetailTheCursorIsIn() {
        val sections = listOf(
            HomeSection("scripts", "", "run", HomeAction.RUN_SCRIPTS),
            HomeSection("remote", "", "review them", HomeAction.REVIEW_OUTDATED),
        )
        val m = model(sections)
        m.setStateForTest(
            HomeState(
                sections = sections,
                open = setOf(HomeAction.RUN_SCRIPTS, HomeAction.REVIEW_OUTDATED),
                scripts = listOf(ScriptRow("pull", "sh pull")),
                remote = RemoteStatus.Answered(listOf(update("kitty", "1", "2")), failedSources = 0),
            ),
        )
        m.intoDetail(section = 1)
        m.handleKey(HomeKey.ESC, viewport = 5)
        assertEquals(setOf(HomeAction.RUN_SCRIPTS), m.state.open, "the other one is left alone")
        assertEquals(false, m.state.exit, "esc closes a detail, it doesn't quit the screen")

        // Its own row has nothing open now, and the scripts picker still
        // does: esc says which key leaves rather than leaving.
        m.handleKey(HomeKey.ESC, viewport = 5)
        assertEquals(false, m.state.exit)
        assertTrue(m.state.message!!.contains("q quits"))

        // And with the whole screen closed up, esc STILL doesn't leave: the
        // key that backs out of a list is never the key that ends the run.
        m.intoDetail(section = 0)
        m.handleKey(HomeKey.ESC, viewport = 5)
        assertTrue(m.state.open.isEmpty())
        assertEquals(false, m.state.exit)
        m.handleKey(HomeKey.ESC, viewport = 5)
        assertEquals(false, m.state.exit, "only q quits")
        assertTrue(m.state.message!!.contains("nothing to close"))
        m.handleKey(HomeKey.QUIT, viewport = 5)
        assertTrue(m.state.exit)
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
        assertEquals(setOf(HomeAction.REVIEW_OUTDATED), m.state.open)
        m.handleKey(HomeKey.CLOSE) // folds the group under the cursor
        m.handleKey(HomeKey.CLOSE) // then closes the section
        assertTrue(m.state.open.isEmpty())

        // `l` never acts: a row with no detail says so instead of dispatching.
        m.setStateForTest(HomeState(sections = sections, cursor = 0))
        m.handleKey(HomeKey.OPEN)
        assertTrue(m.state.open.isEmpty())
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
                open = setOf(HomeAction.REVIEW_OUTDATED),
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
                open = setOf(HomeAction.REVIEW_OUTDATED),
                remote = RemoteStatus.Answered(
                    updates = rows,
                    failedSources = 0,
                    mechanismOf = mapOf("alpha" to "pm", "bravo" to "pm"),
                    toolOf = mapOf("pm" to "pm"),
                    mechanismsOfTool = mapOf("pm" to listOf("pm")),
                ),
            ),
        )
        m.intoDetail()
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

    /**
     * A source's item may be named like a mapped program: the live repo has a
     * `tpack` tmux plugin AND a `tpack` brew cask. The row belongs to its
     * source either way — filed under brew, ticking it ran `brew upgrade`,
     * which cannot fast-forward a git clone, so the row came back outdated
     * after every refresh.
     */
    @Test
    fun aSourceRowNamedLikeAProgramIsNeverTheProgram() {
        val row = loadout.cli.UpdateRow("tpack", "27172d5", "1f8b694", "tmux-plugins", "156 commit(s) behind")
        fun answered(upgradable: Boolean) = RemoteStatus.Answered(
            updates = listOf(row),
            failedSources = 0,
            tools = listOf(
                loadout.cli.ToolUpdates("brew", listOf("brew-cask"), total = 0, declared = emptyList(), others = emptyList(), command = "brew upgrade"),
            ),
            mechanismOf = mapOf("tpack" to "brew-cask"),
            toolOf = mapOf("brew-cask" to "brew"),
            mechanismsOfTool = mapOf("brew" to listOf("brew-cask")),
            sources = mapOf("tmux-plugins" to upgradable),
        )

        // Upgradable: its own item, under its own source.
        val own = answered(upgradable = true)
        assertEquals(
            listOf("Tool", "Gap", "Source", "Item"),
            remoteLines(own).map { it::class.simpleName },
        )
        assertEquals("source:tmux-plugins", remoteLines(own)[3].group)
        assertEquals("item:tmux-plugins/tpack", selectionKey(own, row))

        // Read-only: still its source's row — NOT a brew program. This is the
        // case the old name lookup got wrong, because only upgradable sources
        // were kept out of the tool groups.
        val readOnly = answered(upgradable = false)
        assertEquals(
            listOf("Tool", "Gap", "Source", "Item"),
            remoteLines(readOnly).map { it::class.simpleName },
        )
        assertEquals("source:tmux-plugins", remoteLines(readOnly)[3].group)
        assertNull(selectionKey(readOnly, row), "nothing loadout can move — never brew's sweep")
        assertEquals("tmux-plugins can't update its items from loadout", remoteLines(readOnly)[3].refusal)
    }

    @Test
    fun aCleanToolHasNothingToFoldSoHLeavesTheTable() {
        // A tool with nothing outdated heads no rows. A chevron there
        // promises content that doesn't exist, and folding it hides nothing.
        val answered = RemoteStatus.Answered(
            updates = listOf(update("kitty", "1", "2")),
            failedSources = 0,
            tools = listOf(
                loadout.cli.ToolUpdates("dnf", listOf("dnf"), total = 14, declared = listOf("kitty"), others = emptyList(), command = "sudo dnf upgrade -y"),
                loadout.cli.ToolUpdates("flatpak", listOf("flatpak"), total = 0, declared = emptyList(), others = emptyList(), command = "flatpak --user update -y"),
            ),
            mechanismOf = mapOf("kitty" to "dnf"),
            toolOf = mapOf("dnf" to "dnf", "flatpak" to "flatpak"),
            mechanismsOfTool = mapOf("dnf" to listOf("dnf"), "flatpak" to listOf("flatpak")),
        )
        val lines = remoteLines(answered)
        assertEquals(listOf("Tool", "Program", "Gap", "Tool"), lines.map { it::class.simpleName })
        assertTrue(lines[0].foldable, "dnf heads a row")
        assertFalse(lines[3].foldable, "flatpak heads nothing")
        // Fold dnf, upgrade its row, re-ask: the group is still in `collapsed`
        // with nothing left under it, and must not claim otherwise.
        assertFalse(
            remoteLines(answered, setOf("tool:flatpak")).first { it.group == "tool:flatpak" }.foldable,
            "already folded changes nothing: there is still nothing behind it",
        )

        val sections = listOf(HomeSection("remote", "", "review", HomeAction.REVIEW_OUTDATED))
        val m = model(sections)
        m.setStateForTest(HomeState(sections = sections, remote = answered))
        m.handleKey(HomeKey.OPEN, viewport = 8)
        m.handleKey(HomeKey.DOWN, viewport = 8) // kitty
        m.handleKey(HomeKey.DOWN, viewport = 8) // flatpak, over the gap
        assertEquals(3, m.detailRow)
        m.handleKey(HomeKey.CLOSE, viewport = 8)
        assertTrue(m.state.collapsed.isEmpty(), "nothing folded — there was nothing to fold")
        assertTrue(m.state.open.isEmpty(), "h leaves the table instead of pretending")
    }

    @Test
    fun theRemoteTableIsGroupedByTheToolThatWillAct() {
        val rows = listOf(update("kitty", "1", "2"), update("ruby", "3.4.8", "3.4.10", "asdf-tools"))
        val answered = RemoteStatus.Answered(
            updates = rows,
            failedSources = 0,
            tools = listOf(
                loadout.cli.ToolUpdates("dnf", listOf("dnf"), total = 14, declared = listOf("kitty"), others = listOf("kernel", "glibc"), command = "sudo dnf upgrade -y"),
                loadout.cli.ToolUpdates("flatpak", listOf("flatpak"), total = 0, declared = emptyList(), others = emptyList(), command = "flatpak --user update -y"),
            ),
            mechanismOf = mapOf("kitty" to "dnf"),
            toolOf = mapOf("dnf" to "dnf", "flatpak" to "flatpak"),
            mechanismsOfTool = mapOf("dnf" to listOf("dnf"), "flatpak" to listOf("flatpak")),
            sources = mapOf("asdf-tools" to true),
        )
        val lines = remoteLines(answered)
        // dnf line, kitty under it, the cost, a gap, flatpak (clean, still
        // shown), a gap, then the source and its item.
        assertEquals(
            listOf("Tool", "Program", "Others", "Gap", "Tool", "Gap", "Source", "Item"),
            lines.map { it::class.simpleName },
        )
        // The tool line and its program tick the same thing: the tool.
        assertEquals("tool:dnf", lines[0].key)
        assertEquals("tool:dnf", lines[1].key)
        assertEquals("item:asdf-tools/ruby", lines[7].key)
        // Gaps are not stops; the cost line is (enter lists it in full), and
        // so is a source heading (space ticks everything under it).
        assertEquals(listOf(true, true, true, false, true, false, true, true), lines.map { it.focusable })

        val sections = listOf(HomeSection("remote", "", "review", HomeAction.REVIEW_OUTDATED))
        val m = model(sections)
        m.setStateForTest(HomeState(sections = sections, remote = answered))
        m.handleKey(HomeKey.OPEN, viewport = 8)
        assertEquals(0, m.detailRow)
        m.handleKey(HomeKey.DOWN, viewport = 8)
        m.handleKey(HomeKey.DOWN, viewport = 8)
        assertEquals(2, m.detailRow, "the cost line is a stop")
        assertEquals(false, m.handleKey(HomeKey.ENTER, viewport = 8))
        val list = m.state.run!!
        assertEquals(PaneKind.LIST, list.kind, "enter on it opens the list in the pane")
        assertEquals(listOf("kernel", "glibc"), list.log)
        assertTrue(list.done, "nothing runs: it only shows")
        m.handleKey(HomeKey.ENTER, viewport = 8)
        assertNull(m.state.run, "enter closes it")
        m.handleKey(HomeKey.DOWN, viewport = 8)
        assertEquals(4, m.detailRow, "skips the gap to the next tool")
        m.handleKey(HomeKey.DOWN, viewport = 8)
        assertEquals(6, m.detailRow, "skips the gap to the source heading")
        m.handleKey(HomeKey.SELECT, viewport = 8)
        assertEquals(setOf("item:asdf-tools/ruby"), m.state.selection, "the heading ticks every item under it")
        m.handleKey(HomeKey.SELECT, viewport = 8)
        assertTrue(m.state.selection.isEmpty(), "and clears them when they all are")

        // h inside the table folds the group under the cursor, not the section.
        m.handleKey(HomeKey.UP, viewport = 8) // back to flatpak
        m.handleKey(HomeKey.UP, viewport = 8) // dnf's cost line
        m.handleKey(HomeKey.CLOSE, viewport = 8)
        assertEquals(setOf(HomeAction.REVIEW_OUTDATED), m.state.open, "the section stays open")
        assertEquals(setOf("tool:dnf"), m.state.collapsed)
        assertEquals(0, m.detailRow, "and the cursor lands on the folded heading")
        assertEquals(
            listOf("Tool", "Tool", "Gap", "Source", "Item"),
            remoteLines(answered, m.state.collapsed).map { it::class.simpleName },
            "a folded group keeps only its heading, and stacks on a quiet neighbour",
        )
        m.handleKey(HomeKey.OPEN, viewport = 8)
        assertTrue(m.state.collapsed.isEmpty(), "l on the folded heading unfolds it")
        m.handleKey(HomeKey.OPEN, viewport = 8)
        assertTrue(m.state.collapsed.isEmpty(), "l on an open heading does nothing — it only ever opens")
        m.handleKey(HomeKey.CLOSE, viewport = 8)
        assertEquals(setOf("tool:dnf"), m.state.collapsed, "h folds")
        // Fold a group whose gap above disappears when it folds: the cursor
        // must follow the heading to its NEW index, not stay on the old one.
        m.handleKey(HomeKey.DOWN, viewport = 8) // flatpak
        m.handleKey(HomeKey.DOWN, viewport = 8) // asdf-tools heading (over the gap)
        m.handleKey(HomeKey.CLOSE, viewport = 8)
        assertTrue(m.remoteRow is RemoteLine.Source, "the cursor sits on the folded heading, not the vanished gap")
        m.handleKey(HomeKey.OPEN, viewport = 8)
        assertTrue(m.remoteRow is RemoteLine.Source, "and follows it back down when the gap returns")
        m.handleKey(HomeKey.CLOSE, viewport = 8) // folds it again
        m.handleKey(HomeKey.CLOSE, viewport = 8)
        assertTrue(m.state.open.isEmpty(), "h on a folded heading closes the section")

        // The two keys are NOT the same key: esc is the way out of the table
        // from wherever you are in it, so on a row h would fold it leaves
        // the section and folds nothing on its way.
        m.handleKey(HomeKey.OPEN, viewport = 8)
        m.setStateForTest(m.state.copy(collapsed = emptySet()))
        m.intoDetail(section = 0)
        m.handleKey(HomeKey.DOWN, viewport = 8)
        assertTrue(m.remoteRow is RemoteLine.Program, "a row whose group h would fold")
        m.handleKey(HomeKey.ESC, viewport = 8)
        assertTrue(m.state.open.isEmpty(), "esc closed the whole section")
        assertTrue(m.state.collapsed.isEmpty(), "and folded nothing")
    }

    @Test
    fun kOpensTheRowsPageWhenItsSourceGaveOne() {
        val sections = listOf(HomeSection("remote", "", "review", HomeAction.REVIEW_OUTDATED))
        val m = model(sections)
        val rows = listOf(
            loadout.cli.UpdateRow("golang", "a", "b", "asdf-plugins", "2 commit(s) behind", "https://github.com/x/y/compare/a...b"),
            loadout.cli.UpdateRow("nodejs", "a", "b", "asdf-plugins"),
        )
        m.setStateForTest(
            HomeState(
                sections = sections,
                open = setOf(HomeAction.REVIEW_OUTDATED),
                remote = RemoteStatus.Answered(updates = rows, failedSources = 0, sources = mapOf("asdf-plugins" to true)),
            ),
        )
        assertEquals("https://github.com/x/y/compare/a...b", remoteLines(m.state.remote as RemoteStatus.Answered)[1].link)
        m.intoDetail()
        m.handleKey(HomeKey.DOWN, viewport = 5)
        m.handleKey(HomeKey.DOWN, viewport = 5) // nodejs: no link
        m.handleKey(HomeKey.OPEN_LINK, viewport = 5)
        assertTrue(m.state.message!!.contains("no page"))
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
                open = setOf(HomeAction.REVIEW_OUTDATED),
                remote = RemoteStatus.Answered(
                    updates = rows,
                    failedSources = 0,
                    sources = mapOf("asdf-plugins" to true),
                ),
            ),
        )
        m.intoDetail()
        m.handleKey(HomeKey.DOWN, viewport = 5) // from the source heading to its first item
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
                open = setOf(HomeAction.REVIEW_OUTDATED),
                remote = RemoteStatus.Answered(
                    updates = rows,
                    failedSources = 0,
                    sources = mapOf("asdf-tools" to true, "asdf-plugins" to true),
                ),
            ),
        )
        m.intoDetail()
        m.handleKey(HomeKey.DOWN, viewport = 5) // past the first source heading
        m.handleKey(HomeKey.SELECT, viewport = 5)
        assertEquals(setOf("item:asdf-tools/python"), m.state.selection)
        m.handleKey(HomeKey.DOWN, viewport = 5) // over the second heading, onto its row
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
                open = setOf(HomeAction.REVIEW_OUTDATED),
                remote = RemoteStatus.Answered(listOf(update("oracle", "a", "b")), failedSources = 0),
            ),
        )
        m.intoDetail()
        m.handleKey(HomeKey.DOWN, viewport = 5) // past the source heading
        m.handleKey(HomeKey.SELECT, viewport = 5)
        assertTrue(m.state.selection.isEmpty())
        assertTrue(m.state.message!!.contains("can't update"))
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
        assertEquals(setOf(HomeAction.RUN_SCRIPTS), m.state.open)

        // space on a done script ticks it: that is the force.
        m.handleKey(HomeKey.DOWN, viewport = 5)
        m.handleKey(HomeKey.SELECT, viewport = 5)
        assertEquals(setOf("pull", "apply"), m.state.picked)
        m.handleKey(HomeKey.SELECT_ALL, viewport = 5)
        assertEquals(setOf("pull", "apply"), m.state.picked, "a on a full tick stays full")
        m.handleKey(HomeKey.SELECT_NONE, viewport = 5)
        assertEquals(emptySet(), m.state.picked, "u clears")
        m.handleKey(HomeKey.SELECT_ALL, viewport = 5)
        assertEquals(setOf("pull", "apply"), m.state.picked)

        // enter runs the picks HERE — the screen stays, the pane asks first.
        assertEquals(false, m.handleKey(HomeKey.ENTER, viewport = 5))
        assertEquals(false, m.state.exit)
        val run = m.state.run!!
        assertTrue(run.confirming)
        assertEquals(PaneKind.SCRIPTS, run.kind)
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
        m.setStateForTest(
            HomeState(sections = sections, open = setOf(HomeAction.RUN_SCRIPTS), scripts = listOf(ScriptRow("pull", "sh pull"))),
        )
        // From the subject row of an open picker: enter acts on the subject.
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
                run = PaneRun(steps = listOf("pull"), kind = PaneKind.SCRIPTS, done = true, summary = "done"),
            ),
        )
        m.handleKey(HomeKey.ENTER)
        assertNull(m.state.run)
        assertEquals(setOf("tool:dnf"), m.state.selection, "only an upgrade's own picks are cleared")
    }

    @Test
    fun aDetailThatEmptiedIsRememberedWithoutSwallowingTheArrows() {
        // Every missing program got installed while the picker was open: it
        // has no rows to draw, so the arrows walk the subjects again — and
        // the picker is still open for when a program goes missing again.
        val sections = listOf(
            HomeSection("programs", "", "install", HomeAction.INSTALL_MISSING),
            HomeSection("scripts", "", "run", HomeAction.RUN_SCRIPTS),
        )
        val m = model(sections)
        m.setStateForTest(
            HomeState(sections = sections, open = setOf(HomeAction.INSTALL_MISSING), missing = emptyList()),
        )
        m.handleKey(HomeKey.DOWN, viewport = 5)
        assertEquals(1, m.state.cursor)
        assertEquals(setOf(HomeAction.INSTALL_MISSING), m.state.open)

        val rows = listOf(ProgramRow("kitty", "dnf", "sudo dnf install -y kitty"))
        m.setStateForTest(m.state.copy(missing = rows))
        assertEquals(
            listOf("Subject", "Detail", "Subject"),
            homeLines(m.state).map { it::class.simpleName },
            "the row came back under the subject it belongs to",
        )
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

    @Test
    fun loadoutThemeAnswersForTerminalsThatCannotBeAsked() {
        assertEquals(true, forcedDark("dark"))
        assertEquals(false, forcedDark("light"))
        assertEquals(false, forcedDark(" LIGHT "))
        assertNull(forcedDark(null))
        assertNull(forcedDark(""))
    }

    @Test
    fun anUnreadableLoadoutThemeIsRefusedNotIgnored() {
        // Ignoring it would look exactly like the bug it was set to fix.
        val e = assertFailsWith<ThemeException> { forcedDark("lite") }
        assertTrue("lite" in e.message!!, e.message!!)
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
