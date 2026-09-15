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
import kotlinx.cinterop.set
import kotlinx.cinterop.usePinned
import platform.posix.O_RDWR
import platform.posix.STDOUT_FILENO
import platform.posix.TCSANOW
import platform.posix.TIOCGWINSZ
import platform.posix.cfmakeraw
import platform.posix.close
import platform.posix.gethostname
import platform.posix.ioctl
import platform.posix.isatty
import platform.posix.open
import platform.posix.read
import platform.posix.tcgetattr
import platform.posix.tcsetattr
import platform.posix.termios
import platform.posix.uname
import platform.posix.utsname
import platform.posix.VMIN
import platform.posix.VTIME
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

/** VTIME is in tenths of a second: how long a silent terminal costs us. */
private const val REPLY_TIMEOUT_DECISECONDS: UByte = 2u

/** Caps a drip-feeding terminal at a few timeouts instead of 120 of them. */
private const val MAX_REPLY_READS = 3

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
        // The deadline MUST come from the terminal itself, never from poll():
        // on Darwin poll() answers /dev/tty with POLLNVAL instead of
        // readiness, so a poll guard waves through a read that then blocks
        // FOREVER whenever nothing replies — which is every terminal that
        // swallows the query, a nested tmux (a tmux popup running its own
        // client) being the one people actually hit. cfmakeraw leaves VMIN=1,
        // i.e. "block until a byte arrives"; VMIN=0 + VTIME makes read()
        // return 0 when the reply doesn't come, so detection stays fail-soft.
        raw.c_cc[VMIN] = 0u
        raw.c_cc[VTIME] = REPLY_TIMEOUT_DECISECONDS
        tcsetattr(fd, TCSANOW, raw.ptr)

        val query = "\u001b]11;?\u001b\\".encodeToByteArray()
        query.usePinned { write(fd, it.addressOf(0), query.size.toULong()) }

        // Reply: ESC ] 11 ; rgb:RRRR/GGGG/BBBB (ST or BEL terminated).
        val buf = allocArray<ByteVar>(128)
        var total = 0
        var reads = 0
        while (total < 120 && reads < MAX_REPLY_READS) {
            reads++
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
