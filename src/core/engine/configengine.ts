import { type ConfigState, configApplied, configDrifted, configUnknown } from "../coremodel/coremodel.ts";
import { type ProcessRunner, type ShellCommand, success } from "../exec/index.ts";
import { compareStrings, distinct, isBlank, sortedMap, sortedStrings, sortStrings, trimSpace } from "../../model/index.ts";
import { ConfigException, ConfigNeedsSudoException } from "./errors.ts";
import { lines, shellQuote } from "./text.ts";

/** ConfigUnit is one config unit and the targets chezmoi manages in it, relative to the destination. */
export interface ConfigUnit {
  name: string;
  targets: string[];
}

/**
 * ConfigEntry is one line of `chezmoi status`, target relative to the
 * destination. drifted: `config apply` would change it (the second column).
 * edited: it changed since chezmoi last wrote it (the first column).
 */
export interface ConfigEntry {
  target: string;
  edited: boolean;
  drifted: boolean;
}

/**
 * ConfigSource is one chezmoi source directory; label is what a refusal
 * calls its repo ("this repo", "parent dotfiles"). root is set for a source
 * applied to / (a repo's tool folders' root/, built by compile).
 */
export interface ConfigSource {
  dir: string;
  label: string;
  root?: RootSide;
}

/**
 * RootSide is how a source applied to / runs. chezmoi applies it as root,
 * with an empty config, its own state and cache, and the user's HOME (so a
 * template's .chezmoi.homeDir is the same as in $HOME's configs). Its
 * targets are absolute (`/etc/udev/…`), and each belongs to the tool whose
 * root/ it's in: unit `/<tool>`.
 */
export interface RootSide {
  /** destination is `/`, or a folder standing for it (the integration suite's LOADOUT_ROOT_DESTINATION, applied without sudo). */
  destination: string;
  /** state and cache are chezmoi's, root's: its persistent state is left readable, so observing needs no sudo. */
  state: string;
  cache: string;
  /** sudo is false only for a destination that stands for /. */
  sudo: boolean;
  /** home is the user's HOME, for the templates. */
  home: string;
  /** bin is chezmoi as this user finds it, absolute when it can be: sudo's PATH may not have it (secure_path). */
  bin: string;
  /** toolOf is the tool a source path (relative to dir) was built from. */
  toolOf(sourceRelative: string): string;
  /** exists says whether an absolute path is there (a folder chezmoi would create or leave alone). */
  exists(path: string): boolean;
}

interface ManagedBy {
  source: ConfigSource;
  targets: string[];
  /** units is each target's unit, for a root source (by tool). */
  units: Map<string, string>;
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
 *
 * A repo with tool folders may also have root sources (RootSide), applied
 * to / as root after $HOME's: their targets are absolute (`/etc/…`) and
 * their units are the tools they came from (`/keychron`).
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

  /** sourceList is the sources, in order: `loadout chezmoi` runs chezmoi over this repo's own. */
  sourceList(): readonly ConfigSource[] {
    return this.sources;
  }

  /** environment is what chezmoi runs with (`LOADOUT_REPO`, `LOADOUT_MACHINE`). */
  environment(): Record<string, string> | undefined {
    return this.env;
  }

  /** lastReason is why chezmoi couldn't answer during the last observe, or undefined. */
  lastReason(): string | undefined {
    return this.reason;
  }

  /** managed is each source's managed targets, in source order. */
  private async managed(): Promise<ManagedBy[]> {
    const out: ManagedBy[] = [];
    for (const source of this.sources) out.push(await this.managedBy(source));
    return out;
  }

  private async managedBy(source: ConfigSource): Promise<ManagedBy> {
    if (source.root === undefined) {
      const text = await this.ask(source, "managed --include files,symlinks");
      return { source, targets: lines(text).filter((line) => !isBlank(line)), units: new Map() };
    }
    const listed = await this.managedJSON(source, "files,symlinks");
    const units = new Map<string, string>();
    for (const [target, m] of listed) units.set("/" + target, "/" + source.root.toolOf(m.sourceRelative));
    return { source, targets: [...units.keys()], units };
  }

  /** targetsOf is the targets one source manages (a root source's absolute, `/etc/…`). */
  async targetsOf(source: ConfigSource): Promise<string[]> {
    return (await this.managedBy(source)).targets;
  }

  /** managedJSON is chezmoi's managed entries of the kinds given, target -> source path. */
  private async managedJSON(source: ConfigSource, kinds: string): Promise<Map<string, { sourceRelative: string; absolute: string }>> {
    const text = await this.ask(source, "managed --include " + kinds + " --path-style all --format json");
    const out = new Map<string, { sourceRelative: string; absolute: string }>();
    if (trimSpace(text) === "") return out;
    let parsed: Record<string, { sourceRelative: string; absolute: string }>;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ConfigException("chezmoi: managed printed something that isn't JSON");
    }
    for (const [target, m] of Object.entries(parsed)) out.set(target, m);
    return out;
  }

  /** units is the units chezmoi manages, sorted by name; a unit spanning sources is one unit. */
  async units(): Promise<ConfigUnit[]> {
    const managed = await this.managed();
    const byUnit = new Map<string, string[]>();
    for (const m of managed) {
      for (const t of m.targets) {
        const unit = m.units.get(t) ?? unitOf(t);
        if (!(byUnit.get(unit) ?? []).includes(t)) byUnit.set(unit, [...(byUnit.get(unit) ?? []), t]);
      }
    }
    return [...sortedMap(byUnit)].map(([name, ts]) => ({ name, targets: sortedStrings(ts) }));
  }

  /** entries is every target `chezmoi status` reports, over every source. */
  async entries(): Promise<ConfigEntry[]> {
    const entries: ConfigEntry[] = [];
    for (const source of this.sources) entries.push(...(await this.entriesOf(source)));
    return entries;
  }

  private async entriesOf(source: ConfigSource): Promise<ConfigEntry[]> {
    const entries: ConfigEntry[] = [];
    const text = await this.ask(source, "status --include files,symlinks");
    const prefix = source.root !== undefined ? "/" : "";
    for (const line of lines(text)) {
      if (line.length > 3) entries.push({ target: prefix + line.slice(3), edited: line[0] !== " ", drifted: line[1] !== " " });
    }
    return entries;
  }

  /**
   * edited is the targets apply would change that also changed since chezmoi
   * last wrote them: `config apply` asks before overwriting those, so they need a
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
    // A source chezmoi can't answer for (a root config only root reads)
    // takes down its own units, not the others'.
    const managed: ManagedBy[] = [];
    const entries: ConfigEntry[] = [];
    const down: { root: boolean; reason: string }[] = [];
    for (const source of this.sources) {
      try {
        const m = await this.managedBy(source);
        entries.push(...(await this.entriesOf(source)));
        managed.push(m);
      } catch (e) {
        if (!(e instanceof ConfigException)) throw e;
        down.push({ root: source.root !== undefined, reason: e.message });
      }
    }
    if (down.length > 0) this.reason = down[0]!.reason;
    if (managed.length === 0) {
      const out = new Map<string, ConfigState>();
      for (const name of sortedStrings(previous.keys())) out.set(name, { status: configUnknown, files: [], reason: this.reason! });
      return out;
    }
    const names: string[] = [];
    const unitMap = new Map<string, string>();
    for (const m of managed) for (const [t, u] of m.units) unitMap.set(t, u);
    const unitFor = (t: string) => unitMap.get(t) ?? unitOf(t);
    for (const m of managed) for (const t of m.targets) names.push(unitFor(t));
    const drifted = new Map<string, string[]>();
    for (const e of entries) {
      if (!e.drifted) continue;
      const unit = unitFor(e.target);
      if (!drifted.has(unit)) names.push(unit);
      drifted.set(unit, [...(drifted.get(unit) ?? []), e.target]);
    }
    // The first clash of each unit, by target.
    const overlapping = overlaps(managed);
    const clashes = new Map<string, string>();
    for (const target of overlapping.keys()) {
      const unit = unitFor(target);
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
    // What the sources that couldn't answer had last time: unknown, with why.
    for (const d of down) {
      for (const name of sortedStrings(previous.keys())) {
        if (!out.has(name) && name.startsWith("/") === d.root) out.set(name, { status: configUnknown, files: [], reason: d.reason });
      }
    }
    return sortedMap(out);
  }

  /**
   * applyCommand is `chezmoi apply` for targets (undefined = everything),
   * without a terminal: it fails instead of asking. force overwrites files
   * edited in place.
   */
  async applyCommand(targets: readonly string[] | undefined, force: boolean, extra: readonly string[] = []): Promise<ShellCommand> {
    let flags = " apply --no-tty";
    if (force) flags += " --force";
    for (const f of extra) flags += " " + shellQuote(f);
    if (this.sources.length === 1 && this.sources[0]!.root === undefined) {
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
      const mine = targets === undefined ? undefined : targets.filter((t) => m.targets.includes(t));
      if (mine !== undefined && mine.length === 0) continue;
      if (m.source.root !== undefined) {
        if (await this.rootWork(m.source, m.source.root, mine)) out.push(await this.rootApply(m.source, m.source.root, flags, mine));
        continue;
      }
      out.push(chezmoi(m.source) + flags + (mine === undefined ? "" : await this.paths(m.source, mine)));
    }
    if (out.length === 0) out = ["true"];
    return { line: out.join(" && "), cwd: "", env: this.env };
  }

  /**
   * rootApply is a root source's apply, in two passes. chezmoi sets every
   * folder in its source to its own mode and replaces a symlinked folder
   * with a real one (macOS's /etc -> /private/etc), so a folder already
   * there is left alone: the first pass applies only the folders not there
   * yet and those whose source name carries an attribute (private_, exact_,
   * readonly_, remove_), the second everything else without folders.
   * targets: undefined for all. The state is left readable for observing.
   */
  private async rootApply(source: ConfigSource, root: RootSide, flags: string, targets: readonly string[] | undefined): Promise<string> {
    // Only the folders on the way to the targets asked for (another tool's
    // aren't this apply's), each alone: chezmoi applying a folder would
    // descend into the ones already there, which keep their modes.
    const folders: string[] = [];
    for (const [target, m] of await this.managedJSON(source, "dirs")) {
      const name = target.split("/").pop()!;
      const sourceName = m.sourceRelative.split("/").pop()!;
      const onTheWay = targets === undefined || targets.some((t) => t.startsWith("/" + target + "/"));
      if (onTheWay && (!root.exists(m.absolute) || sourceName !== name)) folders.push(m.absolute);
    }
    const run = (args: string) => rootChezmoi(source, root, this.env, root.sudo) + args;
    const sudo = root.sudo ? "sudo " : "";
    const steps: string[] = [];
    const dir = shellQuote(dirOf(root.state));
    steps.push(sudo + "mkdir -p " + dir + " " + shellQuote(root.cache));
    if (folders.length > 0) steps.push(run(flags + " --include dirs --recursive=false" + folders.map((f) => " " + shellQuote(f)).join("")));
    const paths = targets === undefined ? "" : targets.map((t) => " " + shellQuote(rootPath(root, t))).join("");
    steps.push(run(flags + " --exclude dirs" + paths));
    // The state stays readable whatever the apply did (observing reads it
    // as the user), in a subshell so the next source's apply still chains.
    const state = shellQuote(root.state);
    return (
      "( " + steps.join(" && ") + "; rc=$?; if [ -e " + state + " ]; then " + sudo + "chmod 0755 " + dir + "; " + sudo + "chmod 0644 " + state +
      "; fi; exit $rc )"
    );
  }

  /**
   * rootDrift is each root unit (`/<tool>`) apply would change, with the
   * targets it would change in it: what loadout machine new applies after the
   * core programs. Empty for a repo without root sources.
   */
  async rootDrift(): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!this.sources.some((s) => s.root !== undefined)) return out;
    const units = await this.units();
    for (const e of await this.entries()) {
      if (!e.drifted || !e.target.startsWith("/")) continue;
      const unit = units.find((u) => u.targets.includes(e.target))?.name ?? e.target;
      out.set(unit, [...(out.get(unit) ?? []), e.target]);
    }
    return sortedMap(out);
  }

  /**
   * rootNeedsSudo says whether applying targets (undefined = all) changes
   * anything in a root source that runs with sudo: the CLI asks for the
   * password before it applies.
   */
  async rootNeedsSudo(targets: readonly string[] | undefined): Promise<boolean> {
    for (const source of this.sources) {
      if (source.root?.sudo !== true) continue;
      // Each source asked about its own targets only: chezmoi refuses a path it doesn't manage.
      let mine: string[] | undefined;
      if (targets !== undefined) {
        const its = await this.targetsOf(source);
        mine = targets.filter((t) => its.includes(t));
        if (mine.length === 0) continue;
      }
      if (await this.rootWork(source, source.root, mine)) return true;
    }
    return false;
  }

  /**
   * rootWork says whether applying a root source (to targets; undefined =
   * all) would do anything: a file, script or removal chezmoi has pending,
   * or a folder not there yet. Nothing to do means no apply, so no sudo.
   */
  private async rootWork(source: ConfigSource, root: RootSide, targets: readonly string[] | undefined): Promise<boolean> {
    const paths = targets === undefined ? "" : targets.map((t) => " " + shellQuote(rootPath(root, t))).join("");
    if (trimSpace(await this.ask(source, "status --exclude dirs" + paths)) !== "") return true;
    for (const m of (await this.managedJSON(source, "dirs")).values()) if (!root.exists(m.absolute)) return true;
    return false;
  }

  private async paths(source: ConfigSource, targets: readonly string[]): Promise<string> {
    const destination = trimSpace(await this.ask(source, "target-path"));
    return targets.map((t) => " " + shellQuote(destination + "/" + t)).join("");
  }

  private async ask(source: ConfigSource, args: string): Promise<string> {
    const root = source.root;
    const base = root === undefined ? chezmoi(source) : rootChezmoi(source, root, this.env, false);
    let result = await this.runner.capture({ line: base + " " + args, cwd: "", env: this.env });
    if (success(result)) return result.stdout;
    // A root target (or root's state) this user can't read: again as root,
    // when sudo needs no password; otherwise the caller may ask for it. Any
    // other failure (a template's) is chezmoi's answer, never retried as root.
    if (root !== undefined && root.sudo && /permission denied/i.test(result.stderr)) {
      if (!success(await this.runner.capture({ line: "sudo -n true", cwd: "", env: undefined }))) {
        throw new ConfigNeedsSudoException(firstLine(result) + " (it needs sudo)");
      }
      const asRoot = rootChezmoi(source, root, this.env, true).replace(/^sudo /, "sudo -n ");
      result = await this.runner.capture({ line: asRoot + " " + args, cwd: "", env: this.env });
      if (success(result)) return result.stdout;
    }
    if (result.exitCode === 127) throw new ConfigException("chezmoi is not on PATH");
    throw new ConfigException(firstLine(result));
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

/** firstLine is a failed chezmoi's reason, one line: its first words on stderr, else stdout, else the exit code. */
function firstLine(result: { exitCode: number; stdout: string; stderr: string }): string {
  let line = "exit " + result.exitCode;
  for (const l of [...lines(result.stderr), ...lines(result.stdout)]) {
    if (!isBlank(l)) {
      line = trimSpace(l);
      break;
    }
  }
  return line.startsWith("chezmoi") ? line : "chezmoi: " + line;
}

/** chezmoiLine is chezmoi over source, as this user: a root source too (reading needs no root). */
export function chezmoiLine(source: ConfigSource, env: Record<string, string> | undefined): string {
  return source.root === undefined ? chezmoi(source) : rootChezmoi(source, source.root, env, false);
}

function chezmoi(source: ConfigSource): string {
  return "chezmoi --source " + shellQuote(source.dir) + " --no-pager";
}

/**
 * rootChezmoi is chezmoi over a root source: destination /, an empty config,
 * root's state and cache; asRoot runs it with sudo, passing the user's HOME
 * and the LOADOUT_* variables (sudo clears the environment).
 */
function rootChezmoi(source: ConfigSource, root: RootSide, env: Record<string, string> | undefined, asRoot: boolean): string {
  const args =
    shellQuote(root.bin) + " --source " + shellQuote(source.dir) + " --destination " + shellQuote(root.destination) +
    " --config /dev/null --config-format toml --persistent-state " + shellQuote(root.state) +
    " --cache " + shellQuote(root.cache) + " --no-pager";
  // One umask on both sides: chezmoi computes a file's mode from it, so an
  // observer with another umask would see every file drifted.
  if (!asRoot) return "umask 022 && " + args;
  const vars = { HOME: root.home, ...(env ?? {}) };
  return "sudo sh -c 'umask 022 && exec env \"$@\"' sh " + Object.entries(vars).map(([k, v]) => k + "=" + shellQuote(v)).join(" ") + " " + args;
}

/** rootPath is a root target (`/etc/x`) on the root side's destination. */
function rootPath(root: RootSide, target: string): string {
  return root.destination === "/" ? target : root.destination.replace(/\/$/, "") + target;
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
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
