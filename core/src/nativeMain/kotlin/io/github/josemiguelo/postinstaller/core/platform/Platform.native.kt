package io.github.josemiguelo.postinstaller.core.platform

import kotlin.time.Clock
import kotlin.time.ExperimentalTime
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlinx.cinterop.ByteVar
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.alloc
import kotlinx.cinterop.allocArray
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.toKString
import platform.posix.STDOUT_FILENO
import platform.posix.gethostname
import platform.posix.isatty
import platform.posix.uname
import platform.posix.utsname

@OptIn(ExperimentalForeignApi::class)
actual fun currentHostname(): String = memScoped {
    val size = 256
    val buffer = allocArray<ByteVar>(size)
    if (gethostname(buffer, size.toULong()) != 0) return "unknown"
    buffer.toKString().substringBefore('.')
}

actual fun isStdoutTty(): Boolean = isatty(STDOUT_FILENO) == 1

@OptIn(ExperimentalForeignApi::class)
actual fun unameInfo(): UnameInfo = memScoped {
    val info = alloc<utsname>()
    if (uname(info.ptr) != 0) return UnameInfo("unknown", "unknown")
    UnameInfo(info.sysname.toKString(), info.machine.toKString())
}

@OptIn(ExperimentalTime::class)
actual fun nowIso(): String = Clock.System.now().toString()

actual val blockingDispatcher: CoroutineDispatcher = Dispatchers.IO
