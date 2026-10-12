package loadout.core.engine

/**
 * A step needs sudo's password when its command visibly runs sudo, or when it
 * declares `sudo: true` because it calls sudo from inside (`omarchy pkg add`,
 * a `file:` script). Declared, never guessed: nothing reads a script to find
 * sudo in it. A run whose plan holds such a step asks for the password once,
 * before the first step (cli/Converge.kt's askForSudoUpfront).
 */
private val SUDO = Regex("(^|[^-\\w])sudo\\b")

/** Whether [command] itself invokes sudo (not "pseudo-tty", not "sudoku"). */
fun commandNeedsSudo(command: String): Boolean = SUDO.containsMatchIn(command)
