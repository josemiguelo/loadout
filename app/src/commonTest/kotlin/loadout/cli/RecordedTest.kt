package loadout.cli

import kotlin.test.Test
import kotlin.test.assertEquals

class RecordedTest {
    @Test
    fun quotingSurvivesSpacesAndSingleQuotes() {
        assertEquals("'plain'", shQuote("plain"))
        assertEquals("'a b'", shQuote("a b"))
        assertEquals("'it'\\''s'", shQuote("it's"))
    }

    @Test
    fun utilLinuxScriptTakesTheCommandAsOneStringAndTheLogLast() {
        assertEquals(
            "script -qfec ''\\''/bin/loadout'\\'' '\\''run'\\'' '\\''a b'\\''' '/run/user/1000/x.log'",
            recordCommand(listOf("/bin/loadout", "run", "a b"), "/run/user/1000/x.log", darwin = false),
        )
    }

    @Test
    fun bsdScriptTakesTheLogFirstAndTheCommandAsArgv() {
        assertEquals(
            "script -qF '/tmp/x.log' '/bin/loadout' 'run' 'a b'",
            recordCommand(listOf("/bin/loadout", "run", "a b"), "/tmp/x.log", darwin = true),
        )
    }
}
