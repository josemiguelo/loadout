import { type AppContext, newScreen } from "../app/index.ts";
import { exitWith } from "./errors.ts";
import { echo } from "./spinner.ts";

/**
 * home shows the home screen until the user quits. Every action runs inside
 * it (a child loadout in the screen's run panel), so this only starts it and
 * prints what it ended with, once the normal screen is back: after a
 * self-upgrade (or a sync that upgraded) that is the run's output and how to
 * go on, since the binary on disk is then a different version.
 */
export async function home(a: AppContext): Promise<void> {
  const screen = await newScreen(a);
  const ended = await screen.run();
  if (ended.message !== "") echo(ended.message);
  if (ended.code !== 0) throw exitWith(ended.code);
}
