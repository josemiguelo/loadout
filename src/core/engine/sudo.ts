import { line, type ProcessRunner, success } from "../exec/index.ts";

/**
 * A step needs sudo's password when its command visibly runs sudo, or when
 * it declares `needsSudo` because it calls sudo from inside (`omarchy pkg
 * add`, a `file:` script). Declared, never guessed: nothing reads a script
 * to find sudo in it. A run whose plan holds such a step asks for the
 * password once, before the first step (the CLI's askForSudoUpfront).
 */
const sudo = /(^|[^-\w])sudo\b/;

/** commandNeedsSudo says whether command itself invokes sudo (not "pseudo-tty", not "sudoku"). */
export function commandNeedsSudo(command: string): boolean {
  return sudo.test(command);
}

/**
 * sudoKeepalive keeps sudo's credentials fresh until loadout exits: a shell
 * loop in the background, not a timer in this process, running `sudo -n -v`
 * every 50s while loadout's process ($PPID of the `sh -c` that starts it)
 * lives. It looks every second, so it ends within one of loadout, however
 * loadout ends. It shares loadout's terminal, the one sudo keys its credentials to.
 */
export const sudoKeepalive =
  "( while :; do i=0; while [ $i -lt 50 ]; do kill -0 $PPID 2>/dev/null || exit 0; sleep 1; i=$((i + 1)); done; " +
  "sudo -n -v 2>/dev/null || exit 0; done ) </dev/null >/dev/null 2>&1 &";

/** sudoValid says whether sudo's credentials are valid now, so asking would ask nothing. */
export async function sudoValid(runner: ProcessRunner): Promise<boolean> {
  return success(await runner.capture(line("sudo -n true", "")));
}

/** startSudoKeepalive starts the sudoKeepalive loop. */
export async function startSudoKeepalive(runner: ProcessRunner): Promise<void> {
  await runner.capture(line(sudoKeepalive, ""));
}
