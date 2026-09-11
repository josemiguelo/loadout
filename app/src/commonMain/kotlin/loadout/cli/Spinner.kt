package loadout.cli

import com.github.ajalt.clikt.core.CliktCommand
import loadout.core.platform.blockingDispatcher
import loadout.core.platform.isStdoutTty
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext

/**
 * Run [work] under a braille spinner line (TTY only — piped output sees
 * nothing), clearing the line when done. The work always runs on
 * blockingDispatcher so the spinner loop keeps ticking — wrap every step
 * slow enough to look like a hang (checks, state writes, git) in this.
 */
fun <T> CliktCommand.spinning(message: String, work: suspend () -> T): T {
    val result = runBlocking {
        val spinner = if (isStdoutTty()) {
            launch {
                val frames = listOf("\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f")
                var frame = 0
                while (isActive) {
                    echo("\r${frames[frame++ % frames.size]} $message", trailingNewline = false)
                    delay(120)
                }
            }
        } else {
            null
        }
        try {
            // On blockingDispatcher, not runBlocking's single thread: a
            // blocking call here (git, state write) would freeze the spinner.
            withContext(blockingDispatcher) { work() }
        } finally {
            spinner?.cancelAndJoin()
        }
    }
    if (isStdoutTty()) echo("\r\u001b[K", trailingNewline = false)
    return result
}
