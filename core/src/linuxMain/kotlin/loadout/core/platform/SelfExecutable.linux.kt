package loadout.core.platform

import kotlinx.cinterop.ByteVar
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.allocArray
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.readBytes

@OptIn(ExperimentalForeignApi::class)
actual fun selfExecutable(): String? = memScoped {
    val buf = allocArray<ByteVar>(4096)
    val n = platform.posix.readlink("/proc/self/exe", buf, 4095u)
    if (n <= 0) null else buf.readBytes(n.toInt()).decodeToString()
}
