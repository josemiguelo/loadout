// loadout sets up a machine from a shared config repo and tracks installed
// program versions. The TypeScript port: dispatches to the CLI (src/cli).
// Compiled by bun into one executable per target (package.json's build).
// Until the port reaches parity, the Go binary (cmd/loadout) is the
// reference.

import { execute } from "./cli/root.ts";
import { ExitError, UsageError } from "./cli/errors.ts";
import { fdWriter } from "./cli/spinner.ts";
import { InterruptedByUser } from "./core/exec/exec.ts";
import { envVar, trapInterrupts } from "./core/platform/platform.ts";
import { forcedDark } from "./theme/theme.ts";

/** interrupted is the exit a shell reports for a command stopped by Ctrl-C (128 + SIGINT). */
const interrupted = 130;

const stdout = fdWriter(1);
const stderr = fdWriter(2);

async function run(args: readonly string[]): Promise<number> {
  // Checked first, before anything styles output: an unreadable value is
  // a refusal, never a silent dark default.
  try {
    forcedDark(envVar("LOADOUT_THEME") ?? "");
  } catch (e) {
    stdout.write("error: " + (e as Error).message + "\n");
    return 1;
  }
  // A home-screen run's child (see app.runCommand) takes Ctrl-C here, on
  // the run panel's terminal it shares with its command: it stops and
  // exits 130, which the screen reads as "interrupted".
  if (envVar("LOADOUT_HANDOFF") === "1") trapInterrupts(true);
  try {
    await execute(args);
    return 0;
  } catch (e) {
    return report(e);
  }
}

/**
 * report is err as loadout's exit (contract 9): every refusal and OS error
 * is one clean `error: <message>` line, never a stack trace.
 */
function report(err: unknown): number {
  if (err instanceof ExitError) return err.code;
  if (err instanceof InterruptedByUser) return interrupted;
  if (err instanceof UsageError) {
    stderr.write(err.render() + "\n");
    return 1;
  }
  stdout.write("error: " + (err instanceof Error ? err.message : String(err)) + "\n");
  return 1;
}

process.exit(await run(process.argv.slice(2)));
