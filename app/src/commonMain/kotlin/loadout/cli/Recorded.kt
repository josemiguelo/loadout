package loadout.cli

// A home-screen hand-off runs its subcommand as a child loadout under
// script(1): the child gets a terminal (sudo, prompts and Ctrl-C work as in
// a shell) and everything it prints is recorded, so `v` at the pause can
// show all of it. The alternate screen it runs on keeps no scrollback.

/** [s] single-quoted for sh. */
internal fun shQuote(s: String) = "'" + s.replace("'", "'\\''") + "'"

/**
 * The shell command running [argv] under script(1), recording into [log].
 * The two script(1)s differ: util-linux takes the command as one string and
 * the log last (`-e` passes the command's exit code on); BSD ([darwin])
 * takes the log first, then the command as plain argv, and already exits
 * with the command's code. Both flush as they write (`-f` / `-F`).
 */
internal fun recordCommand(argv: List<String>, log: String, darwin: Boolean): String {
    val command = argv.joinToString(" ") { shQuote(it) }
    return if (darwin) "script -qF ${shQuote(log)} $command"
    else "script -qfec ${shQuote(command)} ${shQuote(log)}"
}

/**
 * awk program turning a transcript into what the terminal showed: each line
 * is the part after its last carriage return (a spinner redraws over
 * itself), and util-linux script's header and footer lines go (BSD `-q`
 * writes none). awk, not sed: BSD sed doesn't read `\r` in a pattern.
 */
internal const val TRANSCRIPT_AWK =
    "NR == 1 && /^Script started on/ { next } /^Script done on/ { next } " +
        "{ sub(/\\r\$/, \"\"); n = split(\$0, part, \"\\r\"); print (n ? part[n] : \"\") }"
