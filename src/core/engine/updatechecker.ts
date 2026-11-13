import { type CommandFrame, type ProcessRunner, success } from "../exec/index.ts";
import { type BatchOracle, type OutdatedSource, shellLine, trimSpace, type VersionCheck } from "../../model/index.ts";
import { fields, group1, ifBlank, indexSpace, lastNonEmptyTrimmed, lines, take } from "./text.ts";
import { forEach, parallelism } from "./versionchecker.ts";

/**
 * SourceRow is one row from a custom outdated source; note is an optional
 * annotation, link a page about the change (a GitHub compare URL) when the
 * source printed one in the tail.
 */
export interface SourceRow {
  name: string;
  current: string;
  candidate: string;
  note: string;
  link?: string;
}

/**
 * SourceResult is the outcome of running one custom source: parsed rows on
 * success, or an error one-liner (exit code + last stderr line) when the
 * command failed.
 */
export interface SourceResult {
  rows: SourceRow[];
  error?: string;
}

/**
 * UpdateChecker runs installers' `outdated` commands: each prints the
 * candidate version available from the remote source (nothing when up to
 * date). Unlike a version check, the exit code is ignored — `dnf
 * check-update` exits 100 exactly when updates exist — only the regex
 * match matters.
 */
export class UpdateChecker {
  /** frame is where manifest commands run and what they get (contract 5). */
  constructor(
    private readonly runner: ProcessRunner,
    private readonly frame: CommandFrame,
  ) {}

  /** candidate is the version the remote offers, or undefined for up to date / no answer. */
  async candidate(outdated: VersionCheck): Promise<string | undefined> {
    if (outdated.regex === undefined) return undefined;
    const result = await this.runner.capture(this.frame.command(shellLine(outdated.command, outdated.path), outdated.origin));
    return group1(outdated.regex, ifBlank(result.stdout, result.stderr));
  }

  /** candidates checks all checks (program name -> outdated command) concurrently. */
  async candidates(checks: ReadonlyMap<string, VersionCheck>): Promise<Map<string, string | undefined>> {
    const names = [...checks.keys()];
    const out = await forEach(names.length, parallelism, (i) => this.candidate(checks.get(names[i]!)!));
    return zip(names, out);
  }

  /**
   * batchCandidates runs one installer's batch oracle (`outdatedAll`): every
   * output line is `<pkg> <candidate text>` — the first whitespace-separated
   * token is the package id, the rest is the text the per-program regex
   * extracts the version from. Exit code ignored, like candidate.
   */
  async batchCandidates(command: string, origin: string, path: readonly string[]): Promise<Map<string, string>> {
    const result = await this.runner.capture(this.frame.command(shellLine(command, path), origin));
    // stdout ONLY: an empty stdout is "nothing outdated", and a tool's
    // stderr is warnings — `brew outdated --cask` once turned a
    // deprecation notice into packages named "Warning:" and "Please".
    const out = new Map<string, string>();
    for (const line of lines(result.stdout)) {
      const trimmed = trimSpace(line);
      const split = indexSpace(trimmed);
      if (split <= 0) continue;
      out.set(trimmed.slice(0, split), trimSpace(trimmed.slice(split)));
    }
    return out;
  }

  /** batchAll runs all batch oracles (installer name -> its oracle) concurrently. */
  async batchAll(oracles: ReadonlyMap<string, BatchOracle>): Promise<Map<string, Map<string, string>>> {
    const names = [...oracles.keys()];
    const out = await forEach(names.length, 0, (i) => {
      const o = oracles.get(names[i]!)!;
      return this.batchCandidates(o.command, o.origin, o.path);
    });
    return zip(names, out);
  }

  /**
   * sourceRows runs one custom `outdated` source: each output line is
   * `<item> <current> <candidate> [note...]` (whitespace-separated; the
   * optional tail renders as a dim annotation, short lines are skipped).
   *
   * Unlike the installer oracles above (which ignore exit codes because `dnf
   * check-update` exits 100 on updates), a custom source is a plain user
   * script and MUST exit 0 when it ran fine — otherwise loadout can't tell a
   * crashed source from one honestly reporting "nothing outdated", and a
   * persistent failure would silently hide updates forever. So a non-zero
   * exit is reported as SourceResult.error (no rows trusted), which the CLI
   * surfaces as a loud line instead of empty output.
   */
  async sourceRows(command: string, origin: string, path: readonly string[]): Promise<SourceResult> {
    const result = await this.runner.capture(this.frame.command(shellLine(command, path), origin));
    if (!success(result)) {
      let message = "exited " + result.exitCode;
      const detail = lastNonEmptyTrimmed(ifBlank(result.stderr, result.stdout));
      if (detail !== undefined && detail !== "") message += ": " + take(detail, 200);
      return { rows: [], error: message };
    }
    const rows: SourceRow[] = [];
    for (const line of lines(ifBlank(result.stdout, result.stderr))) {
      const tokens = fields(line);
      if (tokens.length < 3) continue;
      // A URL in the tail is the row's LINK (the compare page for the two
      // shas, say), not part of the annotation.
      const tail = tokens.slice(3);
      const link = tail.find((t) => t.startsWith("https://") || t.startsWith("http://"));
      const note = tail.filter((t) => link === undefined || t !== link);
      const row: SourceRow = { name: tokens[0]!, current: tokens[1]!, candidate: tokens[2]!, note: note.join(" ") };
      if (link !== undefined) row.link = link;
      rows.push(row);
    }
    return { rows };
  }

  /** sourcesAll runs all custom sources (name -> source) concurrently. */
  async sourcesAll(sources: ReadonlyMap<string, OutdatedSource>): Promise<Map<string, SourceResult>> {
    const names = [...sources.keys()];
    const out = await forEach(names.length, 0, (i) => {
      const s = sources.get(names[i]!)!;
      return this.sourceRows(s.command ?? "", s.origin, s.path);
    });
    return zip(names, out);
  }
}

/** newUpdateChecker is a checker running commands in frame. */
export function newUpdateChecker(runner: ProcessRunner, frame: CommandFrame): UpdateChecker {
  return new UpdateChecker(runner, frame);
}

function zip<V>(names: readonly string[], values: readonly V[]): Map<string, V> {
  return new Map(names.map((n, i) => [n, values[i]!]));
}
