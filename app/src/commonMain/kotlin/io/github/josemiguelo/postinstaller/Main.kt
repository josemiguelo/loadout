package io.github.josemiguelo.postinstaller

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.jakewharton.mosaic.runMosaicBlocking
import com.jakewharton.mosaic.ui.Text
import io.github.josemiguelo.postinstaller.core.TOOL_VERSION
import kotlinx.coroutines.delay

fun main(args: Array<String>) {
    if (args.firstOrNull() == "--tui-test") {
        runMosaicBlocking { Counter() }
    } else {
        println("post-installer $TOOL_VERSION")
    }
}

@Composable
private fun Counter() {
    var count by remember { mutableStateOf(0) }
    Text("post-installer TUI smoke test: $count / 5")
    LaunchedEffect(Unit) {
        while (count < 5) {
            delay(200)
            count++
        }
    }
}
