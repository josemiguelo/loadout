package loadout.core.platform

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
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.plus
import kotlinx.cinterop.readBytes
import kotlinx.cinterop.usePinned
import platform.posix.O_RDWR
import platform.posix.POLLIN
import platform.posix.STDOUT_FILENO
import platform.posix.TCSANOW
import platform.posix.TIOCGWINSZ
import platform.posix.cfmakeraw
import platform.posix.close
import platform.posix.gethostname
import platform.posix.ioctl
import platform.posix.isatty
import platform.posix.open
import platform.posix.poll
import platform.posix.pollfd
import platform.posix.read
import platform.posix.tcgetattr
import platform.posix.tcsetattr
import platform.posix.termios
import platform.posix.uname
import platform.posix.utsname
import platform.posix.winsize
import platform.posix.write

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

@OptIn(ExperimentalForeignApi::class)
actual fun envVar(name: String): String? = platform.posix.getenv(name)?.toKString()

@OptIn(ExperimentalForeignApi::class)
actual fun terminalRows(): Int? = memScoped {
    val ws = alloc<winsize>()
    if (ioctl(STDOUT_FILENO, TIOCGWINSZ.toULong(), ws.ptr) != 0) return null
    ws.ws_row.toInt().takeIf { it > 0 }
}

@OptIn(ExperimentalForeignApi::class)
actual fun terminalColumns(): Int? = memScoped {
    val ws = alloc<winsize>()
    if (ioctl(STDOUT_FILENO, TIOCGWINSZ.toULong(), ws.ptr) != 0) return null
    ws.ws_col.toInt().takeIf { it > 0 }
}

@OptIn(ExperimentalForeignApi::class)
actual fun terminalBackgroundLuma(): Double? = memScoped {
    val fd = open("/dev/tty", O_RDWR)
    if (fd < 0) return null
    val saved = alloc<termios>()
    if (tcgetattr(fd, saved.ptr) != 0) {
        close(fd)
        return null
    }
    try {
        val raw = alloc<termios>()
        tcgetattr(fd, raw.ptr)
        cfmakeraw(raw.ptr)
        tcsetattr(fd, TCSANOW, raw.ptr)

        val query = "\u001b]11;?\u001b\\".encodeToByteArray()
        query.usePinned { write(fd, it.addressOf(0), query.size.toULong()) }

        // Reply: ESC ] 11 ; rgb:RRRR/GGGG/BBBB (ST or BEL terminated).
        val buf = allocArray<ByteVar>(128)
        var total = 0
        val pfd = alloc<pollfd>()
        pfd.fd = fd
        pfd.events = POLLIN.toShort()
        while (total < 120) {
            if (poll(pfd.ptr, 1u, 150) <= 0) break
            val n = read(fd, buf + total, (120 - total).toULong())
            if (n <= 0L) break
            total += n.toInt()
            val soFar = buf.readBytes(total).decodeToString()
            if ('\\' in soFar || '\u0007' in soFar) break
        }
        val reply = buf.readBytes(total).decodeToString()
        val rgb = Regex("rgb:([0-9a-fA-F]{2,4})/([0-9a-fA-F]{2,4})/([0-9a-fA-F]{2,4})").find(reply)
            ?: return null
        fun channel(hex: String) = hex.take(2).toInt(16) / 255.0
        val (r, g, b) = rgb.destructured
        0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    } finally {
        tcsetattr(fd, TCSANOW, saved.ptr)
        close(fd)
    }
}
