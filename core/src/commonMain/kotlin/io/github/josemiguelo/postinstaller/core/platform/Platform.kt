package io.github.josemiguelo.postinstaller.core.platform

/** The machine's hostname, used as the default machine name for state files. */
expect fun currentHostname(): String

/** Whether stdout is attached to a terminal (gates the TUI). */
expect fun isStdoutTty(): Boolean

/** Kernel name (e.g. "Linux", "Darwin") and hardware name (e.g. "x86_64", "arm64"). */
expect fun unameInfo(): UnameInfo

data class UnameInfo(val sysname: String, val machine: String)

/** Current UTC time as an ISO-8601 string (e.g. "2026-08-14T12:00:00Z"). */
expect fun nowIso(): String

/** Dispatcher suited to blocking work (process spawning, file IO). */
expect val blockingDispatcher: kotlinx.coroutines.CoroutineDispatcher

/** Value of the environment variable [name], or null when unset. */
expect fun envVar(name: String): String?
