package loadout.tui

import kotlin.test.Test
import kotlin.test.assertEquals

class ViewportTest {
    @Test
    fun everythingFitsNoScroll() {
        assertEquals(0, windowStart(selected = 0, total = 10, height = 20))
        assertEquals(0, windowStart(selected = 9, total = 10, height = 10))
    }

    @Test
    fun selectionNearTopPinsToStart() {
        assertEquals(0, windowStart(selected = 0, total = 100, height = 10))
        assertEquals(0, windowStart(selected = 4, total = 100, height = 10))
    }

    @Test
    fun selectionMidListStaysCentered() {
        assertEquals(46, windowStart(selected = 50, total = 100, height = 9))
        // Moving down scrolls by one, keeping the selection centered.
        assertEquals(47, windowStart(selected = 51, total = 100, height = 9))
    }

    @Test
    fun selectionNearEndPinsToLastPage() {
        assertEquals(90, windowStart(selected = 99, total = 100, height = 10))
        assertEquals(90, windowStart(selected = 96, total = 100, height = 10))
    }

    @Test
    fun degenerateHeights() {
        assertEquals(0, windowStart(selected = 5, total = 10, height = 0))
        assertEquals(5, windowStart(selected = 5, total = 10, height = 1))
    }

    @Test
    fun terminalThemeDetectionPrefersBackgroundLuma() {
        assertEquals(true, detectDarkTerminal(0.08, null))    // dark bg wins
        assertEquals(false, detectDarkTerminal(0.93, "15;0")) // luma beats COLORFGBG
    }

    @Test
    fun terminalThemeDetectionFallsBackToColorFgBg() {
        assertEquals(true, detectDarkTerminal(null, "15;0"))       // white on black
        assertEquals(true, detectDarkTerminal(null, "7;8"))
        assertEquals(false, detectDarkTerminal(null, "0;15"))      // black on white
        assertEquals(false, detectDarkTerminal(null, "0;7"))
        assertEquals(true, detectDarkTerminal(null, null))         // unknown -> dark
        assertEquals(true, detectDarkTerminal(null, "garbage"))
        assertEquals(false, detectDarkTerminal(null, "12;default;15"))
    }
}
