package loadout.core

/**
 * Anything loadout itself refuses to do, reported to the user as a clean
 * `error: <message>` one-liner (never a stack trace — contract 9).
 *
 * Extend this rather than [Exception] directly: Main.kt catches this one
 * type, so a new failure mode inherits the clean reporting instead of
 * depending on someone remembering to add a catch block.
 */
abstract class LoadoutException(message: String) : Exception(message)
