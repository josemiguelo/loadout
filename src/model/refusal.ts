/**
 * Refusal is anything loadout itself refuses to do, reported to the user as
 * a clean `error: <message>` one-liner, never a stack trace (contract 9).
 * main reports any error that is one; a new failure mode extends it rather
 * than relying on someone remembering to add a case.
 */
export abstract class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** isRefusal says whether e is a Refusal. */
export function isRefusal(e: unknown): e is Refusal {
  return e instanceof Refusal;
}

/** ManifestException is a manifest or lock loadout can't use. */
export class ManifestException extends Refusal {}

/**
 * ToolTooOldException says the lock needs a newer loadout: at least
 * required. `sync` upgrades on it.
 */
export class ToolTooOldException extends Refusal {
  constructor(
    message: string,
    readonly required: string,
  ) {
    super(message);
  }
}
