import { compile } from "../compile/compile.ts";
import { lockFileName } from "../model/index.ts";
import type { Command } from "./args.ts";
import type { CliContext } from "./context.ts";
import { commandHelp } from "./help.ts";
import { appCtx, subcommand } from "./root.ts";
import { echo, spinning } from "./spinner.ts";
import { Style } from "./style.ts";

/**
 * newCompileCmd runs the repo's TypeScript manifests (loadout.ts, with the
 * bun loadout brings) into loadout.lock.json, the one thing every other
 * command reads.
 */
export function newCompileCmd(): Command {
  return subcommand(
    "compile",
    commandHelp("Compile the repo's TypeScript manifests (loadout.ts) into " + lockFileName + "."),
    [],
    () => compileRepo(appCtx()),
  );
}

/**
 * compileRepo compiles a's repo, saying what it wrote and warned; a failed
 * compile is a refusal naming every mistake (one `error: ` line each).
 * `sync` runs it too, for a child whose parent's manifests changed.
 */
export async function compileRepo(a: CliContext): Promise<void> {
  const warnings = await spinning("compiling manifests…", () => compile(a.repoRoot, a.runner));
  echo(" " + Style.ok("✔") + "  wrote " + lockFileName);
  // What the manifests declare but no machine uses.
  for (const w of warnings) echo(" " + Style.warn("!") + "  " + w);
}
