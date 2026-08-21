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
}
