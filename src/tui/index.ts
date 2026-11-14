// The home screen, registered with the app when this module is imported:
// src/main.ts imports it
// for that side effect, and bare `loadout` on a TTY opens it.
import { registerScreen } from "../app/index.ts";
import { newScreen } from "./program.ts";

registerScreen(newScreen);

export { newScreen };
