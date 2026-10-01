package loadout.core.platform

import platform.Foundation.NSBundle

// macOS has no /proc; the main bundle of a command-line tool is the binary itself.
actual fun selfExecutable(): String? = NSBundle.mainBundle.executablePath
