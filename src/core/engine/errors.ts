// Package engine is what loadout does with a manifest: observe, plan,
// install, upgrade, run scripts and configs.

import { Refusal } from "../../model/index.ts";

/** ResolutionException is a plan that could not be built; nothing was executed. */
export class ResolutionException extends Refusal {}

/**
 * UpgradeException is a mechanism that can't be upgraded, and why —
 * refusals are explicit, never silent.
 */
export class UpgradeException extends Refusal {}

/**
 * ConfigException is a refusal about configs: chezmoi couldn't answer, a
 * unit doesn't exist, or files were edited in place.
 */
export class ConfigException extends Refusal {}
