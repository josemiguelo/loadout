import { installed, type MachineState, type SystemInfo } from "../core/coremodel/coremodel.ts";
import * as engine from "../core/engine/index.ts";
import {
  type BatchOracle,
  compareStrings,
  expandFilePrefix,
  type Manifest,
  resolveInstall,
  shownLine,
  sortStrings,
  type VersionCheck,
} from "../model/index.ts";
import { atLeast, VERSION } from "../version.ts";
import type { AppContext } from "./context.ts";
import { behindRelease } from "./selfversion.ts";

/**
 * UpdateRow is one "something newer exists" row, shared by `outdated` and
 * the home screen.
 */
export interface UpdateRow {
  name: string;
  current: string;
  candidate: string;
  source: string;
  note: string;
  /** link is a page about the change: the source printed a URL in its note tail. */
  link?: string;
}

/**
 * ToolUpdates is what one TOOL (dnf, brew, flatpak — grouped by probe, so
 * brew formulae and casks are one line) has to offer, declared or not. The
 * doctor's view: an upgrade is the whole tool, so this is what ticking it
 * means.
 */
export interface ToolUpdates {
  tool: string;
  /** installers is the mechanisms behind it that this machine maps (dnf, dnf-repo, dnf-copr). */
  installers: string[];
  /** total is every outdated package the tool reported. */
  total: number;
  /** declared is, of those, the ones in this machine's loadout (program names). */
  declared: string[];
  /** others is, of those, the ones loadout doesn't declare (package ids, as the tool named them). */
  others: string[];
  /** command is the sweep that upgrades all of it, when the mechanism declares one. */
  command?: string;
}

/** SourceError is a custom source that exited non-zero, and why. */
export interface SourceError {
  label: string;
  reason: string;
}

/** OutdatedReport is everything one round of asking the remotes produced. */
export interface OutdatedReport {
  updates: UpdateRow[];
  /**
   * tools is per tool, in installer declaration order — every tool that was
   * asked, clean ones included.
   */
  tools: ToolUpdates[];
  /** errors is the custom sources that exited non-zero, in declaration order. */
  errors: SourceError[];
  /** unchecked is the installed programs no oracle can answer for, in mapping order. */
  unchecked: string[];
}

/** last is Go's math.MaxInt: after every declared position. */
const last = Number.MAX_SAFE_INTEGER;

/**
 * outdatedReport asks every remote this machine's loadout resolves to.
 * Shared by the `outdated` command and the home screen, so neither owns
 * this logic twice — the home screen in particular must stay a dispatcher.
 *
 * freshSelfCheck asks GitHub for loadout's own release instead of the 6h
 * cache: true for the explicit command, false for the screen that opens on
 * every invocation.
 */
export async function outdatedReport(
  a: AppContext,
  manifest: Manifest,
  system: SystemInfo,
  observed: MachineState,
  freshSelfCheck: boolean,
): Promise<OutdatedReport> {
  const mapped = manifest.machines.get(system.machine)?.pm ?? new Map<string, string>();

  // Only installed programs can be outdated; only variants whose installer
  // declares an oracle can be asked. An installer's batch oracle
  // (`outdated-all`) covers its programs with ONE command; per-program
  // oracles remain for explicit variant overrides.
  const oracles = new Map<string, VersionCheck>();
  const batched = new Map<string, BatchOracle>();
  const installedNames: string[] = [];
  for (const [name, key] of mapped) {
    if (observed.programs.get(name)?.status !== installed) continue;
    installedNames.push(name);
    const resolved = resolveInstall(manifest, name, key);
    if (resolved.outdated !== undefined) oracles.set(name, resolved.outdated);
    if (resolved.outdatedAll !== undefined) batched.set(name, resolved.outdatedAll);
  }
  const batchOracles = new Map<string, BatchOracle>();
  for (const oracle of batched.values()) batchOracles.set(oracle.installer, oracle);
  const unchecked = installedNames.filter((name) => !oracles.has(name) && !batched.has(name));

  const frame = await a.frame(system);
  const checker = engine.newUpdateChecker(a.runner, frame);
  // All three run side by side; the first error, in this order, once all are in.
  const [perProgram, batchResults, sourceResults] = await (async () => {
    const settled = await Promise.allSettled([
      checker.candidates(oracles),
      checker.batchAll(batchOracles),
      checker.sourcesAll(manifest.outdated),
    ] as const);
    for (const s of settled) if (s.status === "rejected") throw s.reason;
    const value = <T>(s: PromiseSettledResult<T>): T => (s as PromiseFulfilledResult<T>).value;
    return [value(settled[0]), value(settled[1]), value(settled[2])] as const;
  })();
  const candidates = new Map(perProgram);
  for (const [name, oracle] of batched) {
    let candidate: string | undefined;
    const raw = batchResults.get(oracle.installer)?.get(oracle.pkg);
    if (raw !== undefined) {
      const re = engine.goRegExp(oracle.regex);
      const m = re?.exec(raw);
      if (m !== null && m !== undefined && m.length > 1) candidate = m[1] ?? "";
    }
    candidates.set(name, candidate);
  }
  const currentOf = (name: string): string | undefined => observed.programs.get(name)?.version;
  const newer = (candidate: string | undefined, current: string | undefined): candidate is string =>
    candidate !== undefined && (current === undefined || candidate !== current);

  const rows: UpdateRow[] = [];
  // The tool itself is a program too.
  const latest = await behindRelease(a.runner, !freshSelfCheck);
  if (latest !== "") rows.push({ name: "loadout", current: VERSION, candidate: latest, source: "release", note: "" });
  for (const [label, res] of sourceResults) {
    for (const r of res.rows) {
      const row: UpdateRow = { name: r.name, current: r.current, candidate: r.candidate, source: label, note: r.note };
      if (r.link !== undefined) row.link = r.link;
      rows.push(row);
    }
  }
  // Custom sources that failed (non-zero exit): surfaced loud so a broken
  // oracle can never masquerade as "nothing outdated". Declaration order.
  const errors: SourceError[] = [];
  for (const label of manifest.outdated.keys()) {
    const res = sourceResults.get(label);
    if (res !== undefined && res.error !== undefined) errors.push({ label, reason: res.error });
  }
  for (const [name, candidate] of candidates) {
    const current = currentOf(name);
    if (newer(candidate, current)) {
      rows.push({ name, current: current ?? "?", candidate, source: mapped.get(name) ?? "", note: "" });
    }
  }

  // The whole picture per tool: the batch oracle already listed every
  // outdated package; keep the count and the undeclared names instead of
  // throwing them away. Mechanisms sharing a probe are one tool.
  const installerOrder = new Map<string, number>();
  [...manifest.installers.keys()].forEach((k, i) => installerOrder.set(k, i));
  const orderOf = (installer: string): number => installerOrder.get(installer) ?? last;
  const byTool = new Map<string, string[]>();
  for (const installer of batchOracles.keys()) {
    const tool = manifest.installers.get(installer)?.probe ?? installer;
    byTool.set(tool, [...(byTool.get(tool) ?? []), installer]);
  }
  const tools: ToolUpdates[] = [];
  for (const [tool, installers] of byTool) {
    const reported = new Set<string>();
    for (const installer of installers) {
      for (const pkg of batchResults.get(installer)?.keys() ?? []) reported.add(pkg);
    }
    const declaredPkgs = new Set<string>();
    const declared: string[] = [];
    for (const [name, oracle] of batched) {
      if (!installers.includes(oracle.installer)) continue;
      declaredPkgs.add(oracle.pkg);
      if (newer(candidates.get(name), currentOf(name))) declared.push(name);
    }
    sortStrings(declared);
    // "Not in your loadout" means not declared at all — a declared
    // package the tool listed but that isn't newer stays out of it.
    const others = sortStrings([...reported].filter((pkg) => !declaredPkgs.has(pkg)));
    let command: string | undefined;
    for (const installer of installers) {
      const upgrade = manifest.installers.get(installer)?.upgrade;
      if (upgrade !== undefined) {
        // What runs, not the manifest's file: shorthand.
        command = shownLine(expandFilePrefix(upgrade));
        break;
      }
    }
    const sorted = [...installers].sort((x, y) => orderOf(x) - orderOf(y));
    tools.push({ tool, installers: sorted, total: reported.size, declared, others, command });
  }
  const minOrder = (t: ToolUpdates): number => Math.min(last, ...t.installers.map(orderOf));
  tools.sort((x, y) => minOrder(x) - minOrder(y));

  // Order: program rows grouped by installer DECLARATION order (list native
  // pms first in your installers fragment), then the self row, then custom
  // oracles in their declaration order. No pm knowledge here — the repo's
  // own ordering is the ordering.
  const oracleOrder = new Map<string, number>();
  [...manifest.outdated.keys()].forEach((k, i) => oracleOrder.set(k, i));
  const installerOf = (program: string): string | undefined => {
    const key = mapped.get(program) ?? "";
    const variant = manifest.programs.get(program)?.install.get(key);
    if (variant !== undefined && variant.installer !== undefined) return variant.installer;
    return manifest.installers.has(key) ? key : undefined;
  };
  const rank = (r: UpdateRow): [number, number] => {
    if (r.source === "release") return [1, 0];
    const i = oracleOrder.get(r.source);
    if (i !== undefined) return [2, i];
    const installer = installerOf(r.name);
    if (installer !== undefined) return [0, orderOf(installer)];
    return [0, last];
  };
  rows.sort((x, y) => {
    const [a1, a2] = rank(x);
    const [b1, b2] = rank(y);
    if (a1 !== b1) return a1 - b1;
    if (a2 !== b2) return a2 - b2;
    return compareStrings(x.name, y.name);
  });
  return { updates: rows, tools, errors, unchecked };
}
