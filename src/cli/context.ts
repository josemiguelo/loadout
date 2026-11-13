// TODO(port, once src/app exists): this file goes. It is the slice of
// internal/app's AppContext that init and compile use (the repo root, the
// machine override, the runner, detection); the commands take app's
// AppContext instead, built by the root as Go's app.New.

import type { SystemInfo } from "../core/coremodel/coremodel.ts";
import { type Detection, newDetection } from "../core/detect/detect.ts";
import { newShellRunner, type ProcessRunner } from "../core/exec/index.ts";
import { dirFS } from "../model/index.ts";
import type { Run } from "./args.ts";

/** CliContext is the shared services, built by the root command before any subcommand runs. */
export interface CliContext {
  repoRoot: string;
  /** machineOverride is --machine ("" = the hostname). */
  machineOverride: string;
  verbose: boolean;
  runner: ProcessRunner;
  detection: Detection;
}

/** newContext is the services over the real shell and filesystem (Go's app.New). */
export function newContext(repoRoot: string, machineOverride: string, verbose: boolean): CliContext {
  const runner = newShellRunner();
  return { repoRoot, machineOverride, verbose, runner, detection: newDetection(runner, dirFS("/")) };
}

/** detectSystem is this machine, named by --machine when given. */
export function detectSystem(a: CliContext): SystemInfo {
  return a.detection.detectSystem(a.machineOverride);
}

/** NotPortedYet refuses a command the TypeScript port doesn't run yet. */
export class NotPortedYet extends Error {}

/**
 * notPorted is the run of a command still waiting for its port (it needs
 * src/app): its help, flags and argument checks are already the Go
 * binary's, so only running it refuses.
 */
export function notPorted(what: string): Run {
  return () => Promise.reject(new NotPortedYet(what + " is not ported to TypeScript yet (use the Go binary)"));
}
