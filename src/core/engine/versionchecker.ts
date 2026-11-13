import { installed, missing, type ProgramState, unknown } from "../coremodel/coremodel.ts";
import { type CommandFrame, type ProcessRunner, success } from "../exec/index.ts";
import { shellLine, type VersionCheck } from "../../model/index.ts";
import { group1, ifBlank, lastNonEmptyTrimmed } from "./text.ts";

/** parallelism bounds the concurrent read-only checks. */
export const parallelism = 8;

/** VersionChecker runs version checks. */
export class VersionChecker {
  /** frame is where manifest commands run and what they get (contract 5). */
  constructor(
    private readonly runner: ProcessRunner,
    private readonly frame: CommandFrame,
  ) {}

  /**
   * check is versionCheck's verdict:
   *   - no version check declared -> unknown
   *   - a check that asks THROUGH a tool (it has a probe) and dies with the
   *     shell's own "command not found" (127; 126 = not executable) ->
   *     unknown, with the reason: the tool never answered, so "missing" would
   *     be a confident lie — `brew` off PATH once reported every brew program
   *     missing. A check with no probe IS the program (`rg --version`), so
   *     there 127 means what it says.
   *   - command exits non-zero otherwise (the tool said no) -> missing, with
   *     the tool's last stderr line when it said anything
   *   - command succeeds and regex matches -> installed with the captured version
   *   - command succeeds but regex does not match -> installed without a version
   */
  async check(versionCheck: VersionCheck | undefined): Promise<ProgramState> {
    if (versionCheck === undefined) return { status: unknown };
    const result = await this.runner.capture(
      this.frame.command(shellLine(versionCheck.command, versionCheck.path), versionCheck.origin),
    );
    const said = lastNonEmptyTrimmed(result.stderr);
    if (versionCheck.probe !== undefined && (result.exitCode === 127 || result.exitCode === 126)) {
      // The shell already names what wasn't there ("sh: brew: command not
      // found"); that is the whole explanation.
      return { status: unknown, reason: said ?? `the check could not run (exit ${result.exitCode})` };
    }
    if (!success(result)) return said === undefined ? { status: missing } : { status: missing, reason: said };
    const output = ifBlank(result.stdout, result.stderr);
    // A yes/no check (no regex) records presence alone.
    const version = versionCheck.regex !== undefined ? group1(versionCheck.regex, output) : undefined;
    return version === undefined ? { status: installed } : { status: installed, version };
  }

  /**
   * checkAll checks all checks (program name -> version check) concurrently
   * with bounded parallelism, in checks' order.
   */
  async checkAll(checks: ReadonlyMap<string, VersionCheck | undefined>): Promise<Map<string, ProgramState>> {
    const names = [...checks.keys()];
    const states = await forEach(names.length, parallelism, (i) => this.check(checks.get(names[i]!)));
    return new Map(names.map((name, i) => [name, states[i]!]));
  }
}

/** newVersionChecker is a checker running commands in frame. */
export function newVersionChecker(runner: ProcessRunner, frame: CommandFrame): VersionChecker {
  return new VersionChecker(runner, frame);
}

/**
 * forEach runs f(0..n-1) concurrently, at most limit at a time (0 = no
 * limit), and waits for all of them: their results in index order, or the
 * first error by index once every one has settled.
 */
export async function forEach<T>(n: number, limit: number, f: (i: number) => Promise<T>): Promise<T[]> {
  const gate = limiter(limit <= 0 ? n : limit);
  const settled = await Promise.allSettled(Array.from({ length: n }, (_, i) => gate(() => f(i))));
  return settled.map((s) => {
    if (s.status === "rejected") throw s.reason;
    return s.value;
  });
}

/**
 * limiter is a gate letting at most limit calls run at once (at least one);
 * the others wait, starting in the order they came.
 */
export function limiter(limit: number): <T>(f: () => Promise<T>) => Promise<T> {
  const max = Math.max(limit, 1);
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(f: () => Promise<T>): Promise<T> => {
    // A finishing call hands its permit straight to the next in line.
    if (running >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await f();
    } finally {
      const next = waiting.shift();
      if (next !== undefined) next();
      else running--;
    }
  };
}
