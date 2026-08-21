package loadout.tui

import loadout.cli.AppContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import okio.Path.Companion.toPath

class DashboardModelTest {
    private fun model(rows: Int = 3, mode: Mode = Mode.NORMAL, selected: Int = 0): DashboardModel {
        val m = DashboardModel(AppContext("/repo".toPath(), "manifest.toml", null, false))
        m.setStateForTest(
            TuiState(
                rows = (1..rows).map { RowUi("row$it", isScript = false, cells = emptyMap(), flags = "") },
                mode = mode,
                selected = selected,
            ),
        )
        return m
    }

    @Test
    fun navigationClampsToBounds() {
        val m = model(rows = 2)
        m.handleKey(Key.UP)
        assertEquals(0, m.state.selected)
        m.handleKey(Key.DOWN)
        assertEquals(1, m.state.selected)
        m.handleKey(Key.DOWN)
        assertEquals(1, m.state.selected)
    }

    @Test
    fun detailsToggles() {
        val m = model()
        assertNull(m.handleKey(Key.D))
        assertEquals(Mode.DETAILS, m.state.mode)
        assertNull(m.handleKey(Key.D))
        assertEquals(Mode.NORMAL, m.state.mode)
    }

    @Test
    fun themeTogglesInBrowseModesButNotWhileBusy() {
        val m = model()
        val initial = m.state.dark
        assertNull(m.handleKey(Key.T))
        assertEquals(!initial, m.state.dark)
        assertNull(m.handleKey(Key.T))
        assertEquals(initial, m.state.dark)

        val busy = model(mode = Mode.BUSY)
        val before = busy.state.dark
        busy.handleKey(Key.T)
        assertEquals(before, busy.state.dark)
    }

    @Test
    fun quitSetsExitOnlyInNormalMode() {
        val m = model(mode = Mode.DETAILS)
        m.handleKey(Key.Q)
        assertEquals(false, m.state.exit)
        assertEquals(Mode.NORMAL, m.state.mode)
        m.handleKey(Key.Q)
        assertTrue(m.state.exit)
    }

    @Test
    fun actionKeysReturnAsyncActionsAndGoBusy() {
        assertEquals(AsyncAction.REFRESH, model().handleKey(Key.R))
        assertEquals(AsyncAction.PREPARE_SELECTED, model().handleKey(Key.I))
        assertEquals(AsyncAction.PREPARE_ALL, model().handleKey(Key.A))
        assertEquals(AsyncAction.SYNC, model().handleKey(Key.S))

        val m = model()
        m.handleKey(Key.R)
        assertEquals(Mode.BUSY, m.state.mode)
    }

    @Test
    fun busyIgnoresAllKeys() {
        val m = model(mode = Mode.BUSY)
        for (key in Key.entries) {
            assertNull(m.handleKey(key))
        }
        assertEquals(Mode.BUSY, m.state.mode)
        assertEquals(false, m.state.exit)
    }

    @Test
    fun confirmPlanYesExecutesNoCancels() {
        val yes = model(mode = Mode.CONFIRM_PLAN)
        assertEquals(AsyncAction.EXECUTE_PLAN, yes.handleKey(Key.Y))
        assertEquals(Mode.BUSY, yes.state.mode)

        val no = model(mode = Mode.CONFIRM_PLAN)
        assertNull(no.handleKey(Key.N))
        assertEquals(Mode.NORMAL, no.state.mode)
        assertEquals("cancelled", no.state.message)
    }

    @Test
    fun logViewTogglesAndDoesNotExitOnQ() {
        val m = model()
        m.handleKey(Key.L)
        assertEquals(Mode.LOG, m.state.mode)
        m.handleKey(Key.Q)
        assertEquals(Mode.NORMAL, m.state.mode)
        assertEquals(false, m.state.exit)
        m.handleKey(Key.L)
        m.handleKey(Key.L)
        assertEquals(Mode.NORMAL, m.state.mode)
    }

    @Test
    fun installOnEmptyDashboardDoesNothing() {
        val m = model(rows = 0)
        assertNull(m.handleKey(Key.I))
        assertEquals(Mode.NORMAL, m.state.mode)
    }
}
