import { type ConfigState, configApplied, configDrifted, configUnknown } from "../coremodel/coremodel.ts";
import { type ProcessRunner, type ShellCommand, success } from "../exec/index.ts";
import { compareStrings, distinct, isBlank, sortedMap, sortedStrings, sortStrings, trimSpace } from "../../model/index.ts";
import { ConfigException } from "./errors.ts";
import { lines, shellQuote } from "./text.ts";

/** ConfigUnit is one config unit and the targets chezmoi manages in it, relative to the destination. */
export interface ConfigUnit {
  name: string;
  targets: string[];
}

/**
 * ConfigEntry is one line of `chezmoi status`, target relative to the
 * destination. drifted: `apply` would change it (the second column).
 * edited: it changed since chezmoi last wrote it (the first column).
 */
export interface ConfigEntry {
  target: string;
  edited: boolean;
  drifted: boolean;
}

/**
 * ConfigSource is one chezmoi source directory; label is what a refusal
 * calls its repo ("this repo", "parent dotfiles").
 */
export interface ConfigSource {
  dir: string;
  label: string;
}

interface ManagedBy {
  source: ConfigSource;
  targets: string[];
}

/**
 * ConfigEngine is the repo's dotfiles as loadout sees them, through
 * chezmoi, with `layout configs` as its source directory. A unit is a
 * top-level config: `.config/<name>` is `<name>`, anything else its first
 * path segment (`.zshenv`, `.local`). Units come from chezmoi's own list,
 * so `.chezmoiignore` decides what exists; nothing is opted in. Only the
 * command applyCommand builds changes anything.
 *
 * A child repo (contract 18) has two sources, its parent's and its own, in
 * that order: a unit may span both, and a target both manage is refused
 * (one file, one repo). chezmoi runs with env (`LOADOUT_REPO`,
 * `LOADOUT_MACHINE`), so templates see the machine loadout runs as.
 */
export class ConfigEngine {
  private readonly sources: ConfigSource[];
  private reason: string | undefined;

  /** sources: a source without a label ("") is "this repo"; env undefined = the environment as it is. */
  constructor(
    private readonly runner: ProcessRunner,
    sources: readonly ConfigSource[],
    private readonly env: Record<string, string> | undefined,
  ) {
    this.sources = sources.map((s) => (s.label === "" ? { ...s, label: "this repo" } : { ...s }));
  }

  /** lastReason is why chezmoi couldn't answer during the last observe, or undefined. */
  lastReason(): string | undefined {
    return this.reason;
  }

  /** managed is each source's managed targets, in source order. */
  private async managed(): Promise<ManagedBy[]> {
    const out: ManagedBy[] = [];
    for (const source of this.sources) {
      const text = await this.ask(source, "managed --include files,symlinks");
      out.push({ source, targets: lines(text).filter((line) => !isBlank(line)) });
    }
    return out;
  }

  /** units is the units chezmoi manages, sorted by name; a unit spanning sources is one unit. */
  async units(): Promise<ConfigUnit[]> {
    const managed = await this.managed();
    const targets = managed.flatMap((m) => m.targets);
    const byUnit = new Map<string, string[]>();
    for (const t of distinct(targets)) byUnit.set(unitOf(t), [...(byUnit.get(unitOf(t)) ?? []), t]);
    return [...sortedMap(byUnit)].map(([name, ts]) => ({ name, targets: sortedStrings(ts) }));
  }

  /** entries is every target `chezmoi status` reports, over every source. */
  async entries(): Promise<ConfigEntry[]> {
    const entries: ConfigEntry[] = [];
    for (const source of this.sources) {
      const text = await this.ask(source, "status --include files,symlinks");
      for (const line of lines(text)) {
        if (line.length > 3) entries.push({ target: line.slice(3), edited: line[0] !== " ", drifted: line[1] !== " " });
      }
    }
    return entries;
  }

  /**
   * edited is the targets apply would change that also changed since chezmoi
   * last wrote them: `apply` asks before overwriting those, so they need a
   * decision. Limited to targets when not undefined.
   */
  async edited(targets: readonly string[] | undefined): Promise<string[]> {
    const out = (await this.entries())
      .filter((e) => e.edited && e.drifted && (targets === undefined || targets.includes(e.target)))
      .map((e) => e.target);
    return sortStrings(out);
  }

  /**
   * observe observes every unit: applied when nothing in it would change on
   * apply, else drifted with those files. When chezmoi can't answer, the
   * units last seen in previous are unknown with the reason (also lastReason).
   */
  async observe(previous: ReadonlyMap<string, ConfigState>): Promise<Map<string, ConfigState>> {
    this.reason = undefined;
    let managed: ManagedBy[];
    let entries: ConfigEntry[];
    try {
      managed = await this.managed();
      entries = await this.entries();
    } catch (e) {
      if (!(e instanceof ConfigException)) throw e;
      const reason = e.message;
      this.reason = reason;
      const out = new Map<string, ConfigState>();
      for (const name of sortedStrings(previous.keys())) out.set(name, { status: configUnknown, files: [], reason });
      return out;
    }
    const names: string[] = [];
    for (const m of managed) for (const t of m.targets) names.push(unitOf(t));
    const drifted = new Map<string, string[]>();
    for (const e of entries) {
      if (!e.drifted) continue;
      const unit = unitOf(e.target);
      if (!drifted.has(unit)) names.push(unit);
      drifted.set(unit, [...(drifted.get(unit) ?? []), e.target]);
    }
    // The first clash of each unit, by target.
    const overlapping = overlaps(managed);
    const clashes = new Map<string, string>();
    for (const target of overlapping.keys()) {
      const unit = unitOf(target);
      const first = clashes.get(unit);
      if (first === undefined || compareStrings(target, first) < 0) clashes.set(unit, target);
    }
    const out = new Map<string, ConfigState>();
    for (const name of sortStrings(distinct(names))) {
      const files = sortStrings(distinct(drifted.get(name) ?? []));
      const clash = clashes.get(name);
      if (clash !== undefined) {
        out.set(name, { status: configUnknown, files: [], reason: clashMessage(clash, overlapping.get(clash)!) });
      } else if (files.length === 0) {
        out.set(name, { status: configApplied, files: [] });
      } else {
        out.set(name, { status: configDrifted, files });
      }
    }
    return out;
  }

  /**
   * applyCommand is `chezmoi apply` for targets (undefined = everything),
   * without a terminal: it fails instead of asking. force overwrites files
   * edited in place.
   */
  async applyCommand(targets: readonly string[] | undefined, force: boolean): Promise<ShellCommand> {
    let flags = " apply --no-tty";
    if (force) flags += " --force";
    if (this.sources.length === 1) {
      const source = this.sources[0]!;
      const paths = targets !== undefined ? await this.paths(source, targets) : "";
      return { line: chezmoi(source) + flags + paths, cwd: "", env: this.env };
    }
    // Each source applies its own targets, the parent's first.
    const managed = await this.managed();
    let first = "";
    let firstLabels: string[] = [];
    for (const [target, labels] of overlaps(managed)) {
      if ((targets === undefined || targets.includes(target)) && (first === "" || compareStrings(target, first) < 0)) {
        first = target;
        firstLabels = labels;
      }
    }
    if (first !== "") throw new ConfigException(clashMessage(first, firstLabels));
    let out: string[] = [];
    for (const m of managed) {
      if (targets === undefined) {
        out.push(chezmoi(m.source) + flags);
        continue;
      }
      const mine = targets.filter((t) => m.targets.includes(t));
      if (mine.length === 0) continue;
      out.push(chezmoi(m.source) + flags + (await this.paths(m.source, mine)));
    }
    if (out.length === 0) out = ["true"];
    return { line: out.join(" && "), cwd: "", env: this.env };
  }

  private async paths(source: ConfigSource, targets: readonly string[]): Promise<string> {
    const destination = trimSpace(await this.ask(source, "target-path"));
    return targets.map((t) => " " + shellQuote(destination + "/" + t)).join("");
  }

  private async ask(source: ConfigSource, args: string): Promise<string> {
    const result = await this.runner.capture({ line: chezmoi(source) + " " + args, cwd: "", env: this.env });
    if (success(result)) return result.stdout;
    if (result.exitCode === 127) throw new ConfigException("chezmoi is not on PATH");
    let line = "exit " + result.exitCode;
    for (const l of [...lines(result.stderr), ...lines(result.stdout)]) {
      if (!isBlank(l)) {
        line = trimSpace(l);
        break;
      }
    }
    if (!line.startsWith("chezmoi")) line = "chezmoi: " + line;
    throw new ConfigException(line);
  }
}

/** newConfigEngine is chezmoi over sources (a source without a label is "this repo"), run with env. */
export function newConfigEngine(runner: ProcessRunner, sources: readonly ConfigSource[], env: Record<string, string> | undefined): ConfigEngine {
  return new ConfigEngine(runner, sources, env);
}

/** newSingleConfigEngine is chezmoi over one source directory, this repo's. */
export function newSingleConfigEngine(runner: ProcessRunner, sourceDir: string): ConfigEngine {
  return new ConfigEngine(runner, [{ dir: sourceDir, label: "" }], undefined);
}

function chezmoi(source: ConfigSource): string {
  return "chezmoi --source " + shellQuote(source.dir) + " --no-pager";
}

/** overlaps is the targets more than one source manages, with the sources' labels. */
function overlaps(managed: readonly ManagedBy[]): Map<string, string[]> {
  const labels = new Map<string, string[]>();
  for (const m of managed) for (const t of m.targets) labels.set(t, [...(labels.get(t) ?? []), m.source.label]);
  const out = new Map<string, string[]>();
  for (const [t, l] of labels) if (l.length > 1) out.set(t, l);
  return out;
}

function clashMessage(target: string, labels: readonly string[]): string {
  return target + " is managed by " + labels.join(" and ") + " — a file belongs to one repo";
}

/** unitOf is the unit a target belongs to: `.config/<name>/…` is `<name>`, else the first segment. */
export function unitOf(target: string): string {
  const parts = target.split("/");
  if (parts[0] === ".config" && parts.length >= 2) return parts[1]!;
  return parts[0]!;
}
