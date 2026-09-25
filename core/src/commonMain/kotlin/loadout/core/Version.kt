package loadout.core

const val TOOL_VERSION: String = "0.16.1"

/** The curl|sh bootstrap — used by `loadout self-upgrade` and the floor refusal. */
const val INSTALL_COMMAND: String =
    "curl -fsSL https://raw.githubusercontent.com/josemiguelo/loadout/master/install.sh | sh"
