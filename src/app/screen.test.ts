import { expect, test } from "bun:test";
import {
  ActionApplyConfigs,
  ActionHandOff,
  ActionInstallMissing,
  ActionNone,
  ActionReviewOutdated,
  ActionRunScripts,
  ActionSetup,
  ActionShowDiff,
  ActionSync,
  ActionUpgrade,
  type Closed,
  closedCommand,
  type Handoff,
  type HomeAction,
  PaneConfigs,
  PaneInstall,
  PaneList,
  PaneScripts,
  PaneUpgrade,
} from "./screen.ts";

test("each confirmed action runs the command it names", () => {
  const cases: [Closed, string][] = [
    [{ action: ActionUpgrade }, "self-upgrade"],
    [{ action: ActionSync }, "sync"],
    [{ action: ActionSetup }, "setup-new-machine"],
    // The pane already asked: the command's own confirmation is skipped.
    [{ action: ActionHandOff, handoff: { kind: PaneInstall, args: ["fd", "rg"] } }, "install fd rg --yes"],
    [{ action: ActionHandOff, handoff: { kind: PaneScripts, args: ["dots"] } }, "run dots --force"],
    // The screen already refused files edited here; never --force from it.
    [{ action: ActionHandOff, handoff: { kind: PaneConfigs, args: ["zsh"] } }, "apply zsh"],
    [{ action: ActionHandOff, handoff: { kind: PaneUpgrade, args: ["brew"] } }, "upgrade brew --yes"],
    [{ action: ActionHandOff, handoff: { kind: PaneList, args: ["--item", "pins/x"] } }, "upgrade --item pins/x --yes"],
  ];
  for (const [closed, want] of cases) {
    const command = closedCommand(closed);
    expect(command).toBeDefined();
    expect([command!.name, ...command!.args].join(" ")).toBe(want);
  }
});

test("quitting or a row verb runs nothing", () => {
  const verbs: HomeAction[] = [ActionNone, ActionRunScripts, ActionInstallMissing, ActionApplyConfigs, ActionReviewOutdated, ActionShowDiff];
  for (const action of verbs) {
    expect(closedCommand({ action })).toBeUndefined();
  }
  // a hand-off without its command runs none
  expect(closedCommand({ action: ActionHandOff })).toBeUndefined();
});

test("a handoff's args are not changed", () => {
  const h: Handoff = { kind: PaneInstall, args: ["fd"] };
  closedCommand({ action: ActionHandOff, handoff: h });
  expect(h.args).toEqual(["fd"]);
});
