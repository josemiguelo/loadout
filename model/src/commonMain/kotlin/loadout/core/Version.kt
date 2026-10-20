package loadout.core

/** The curl|sh bootstrap — used by `loadout self-upgrade` and the floor refusal. */
const val INSTALL_COMMAND: String =
    "curl -fsSL https://raw.githubusercontent.com/josemiguelo/loadout/master/install.sh | sh"

/** Numeric dotted-version comparison: is [current] >= [required]? */
fun versionAtLeast(current: String, required: String): Boolean {
    val c = current.split('.').map { it.toIntOrNull() ?: 0 }
    val r = required.split('.').map { it.toIntOrNull() ?: 0 }
    for (i in 0 until maxOf(c.size, r.size)) {
        val a = c.getOrElse(i) { 0 }
        val b = r.getOrElse(i) { 0 }
        if (a != b) return a > b
    }
    return true
}
