// The home screen (bare `loadout` on a TTY) observes, and runs every action
// it confirms as the matching subcommand: a child loadout in a
// pseudo-terminal shown inside the screen (runCommand). It owns no domain
// logic; the CLI only starts it (cli's home) and prints what it ends with.
// They meet here, so neither package imports the other.

import type { AppContext } from "./context.ts";

/**
 * HomeAction is what the user chose. The screen decides; the matching
 * command does it. The values are Go's iota's.
 */
export type HomeAction =
  | typeof ActionNone
  | typeof ActionRunScripts
  | typeof ActionInstallMissing
  | typeof ActionApplyConfigs
  | typeof ActionReviewOutdated
  | typeof ActionShowDiff
  | typeof ActionSync
  | typeof ActionUpgrade
  | typeof ActionSetup
  | typeof ActionHandOff;

export const ActionNone = 0;

// Row verbs: what the focused subject needs. Each subject's list is in
// the screen; acting on its ticks is a HandOff. None of these runs a
// command by itself.
export const ActionRunScripts = 1;
export const ActionInstallMissing = 2;
export const ActionApplyConfigs = 3;
export const ActionReviewOutdated = 4;
export const ActionShowDiff = 5;

// Whole-machine verbs, on their own keys — they belong to no single row.
export const ActionSync = 6;
/** ActionUpgrade is self-upgrade: ends the loop afterwards. */
export const ActionUpgrade = 7;
export const ActionSetup = 8;

/** ActionHandOff runs Closed.handoff, confirmed in the screen's dialog. */
export const ActionHandOff = 9;

/**
 * PaneKind is what the screen's confirm dialog asked about, and so which
 * command a run starts.
 */
export type PaneKind = typeof PaneUpgrade | typeof PaneScripts | typeof PaneInstall | typeof PaneConfigs | typeof PaneList;

export const PaneUpgrade = 0;
export const PaneScripts = 1;
export const PaneInstall = 2;
export const PaneConfigs = 3;
/**
 * PaneList only shows a list (the "N more not in your loadout" packages);
 * a run of it is an upgrade.
 */
export const PaneList = 4;

/** asking says the pane asks a question (Run/Cancel), rather than only listing. */
export function asking(k: PaneKind): boolean {
  return k !== PaneList;
}

/**
 * Handoff is the command a confirmed dialog runs: kind picks it, args are its
 * arguments as the screen built them (program, script, config or
 * `<installer>`/`--item <source>/<name>` names), without the confirmation
 * flags closedCommand adds.
 */
export interface Handoff {
  kind: PaneKind;
  args: string[];
}

/**
 * Closed is an action the user confirmed: the action, and with ActionHandOff
 * the command it runs.
 */
export interface Closed {
  action: HomeAction;
  handoff?: Handoff;
}

/** ClosedCommand is a subcommand and its arguments. */
export interface ClosedCommand {
  name: string;
  args: string[];
}

/**
 * closedCommand is the subcommand and arguments a run starts for c;
 * undefined means there is nothing to run. The dialog already asked, so the
 * command's own confirmation is skipped.
 */
export function closedCommand(c: Closed): ClosedCommand | undefined {
  switch (c.action) {
    case ActionUpgrade:
      return { name: "self-upgrade", args: [] };
    case ActionSync:
      return { name: "sync", args: [] };
    case ActionSetup:
      return { name: "setup-new-machine", args: [] };
    case ActionHandOff: {
      if (c.handoff === undefined) return undefined;
      const args = [...c.handoff.args];
      switch (c.handoff.kind) {
        case PaneInstall:
          return { name: "install", args: [...args, "--yes"] };
        case PaneScripts:
          // `run` has no confirmation; --force runs a ticked script even when done.
          return { name: "run", args: [...args, "--force"] };
        case PaneConfigs:
          // The screen already refused files edited here; never --force from it.
          return { name: "apply", args };
        default:
          return { name: "upgrade", args: [...args, "--yes"] };
      }
    }
  }
  return undefined;
}

/**
 * Screen is the home screen: run draws it on the terminal's alternate
 * screen until the user quits (or a run replaced loadout's binary), then
 * gives the terminal back as it was.
 */
export interface Screen {
  /**
   * run shows the screen until it ends. A rejection is a terminal that
   * couldn't be bound; the CLI reports it.
   */
  run(): Promise<Ended>;
}

/**
 * Ended is how the screen ended: message (may be empty) is printed on the
 * normal screen afterwards, and code is loadout's exit code (a self-upgrade
 * that failed ends the screen with its code).
 */
export interface Ended {
  message: string;
  code: number;
}

/**
 * ScreenFactory builds the home screen for app: it loads the stored state
 * and starts the first refresh.
 */
export type ScreenFactory = (app: AppContext) => Screen | Promise<Screen>;

let screenFactory: ScreenFactory | undefined;

/**
 * registerScreen is how a TUI registers itself (Go's `app.NewScreen = …` in
 * the tui package's init; src/main.ts imports that module). Until one does,
 * bare `loadout` on a TTY prints help.
 */
export function registerScreen(factory: ScreenFactory): void {
  screenFactory = factory;
}

/** hasScreen says whether a TUI registered itself (Go's `app.NewScreen != nil`). */
export function hasScreen(): boolean {
  return screenFactory !== undefined;
}

/** newScreen builds the registered home screen for app; throws when none registered. */
export async function newScreen(app: AppContext): Promise<Screen> {
  if (screenFactory === undefined) throw new Error("no home screen registered");
  return screenFactory(app);
}
