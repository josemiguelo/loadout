// The slice of bubbles/key the screen uses: a binding is the keys that
// trigger it and its help text; a disabled one, or one without keys, is
// neither matched nor shown in help.

/** Help is a binding's help: the key as shown and what it does. */
export interface Help {
  readonly key: string;
  readonly desc: string;
}

/** Binding is a key binding. */
export class Binding {
  constructor(
    readonly keys: readonly string[] | null,
    readonly help: Help = { key: "", desc: "" },
    readonly disabled = false,
  ) {}

  /** enabled says the binding is matched and shown: not disabled, with keys. */
  enabled(): boolean {
    return !this.disabled && this.keys !== null;
  }
}

/** newBinding is key.NewBinding(WithKeys(...), WithHelp(...), WithDisabled()). */
export function newBinding(opts: { keys?: string[]; help?: [string, string]; disabled?: boolean }): Binding {
  return new Binding(opts.keys ?? null, opts.help ? { key: opts.help[0], desc: opts.help[1] } : undefined, opts.disabled ?? false);
}

/** matches says whether key (a key's string, such as "ctrl+c") triggers any enabled binding. */
export function matches(key: string, ...bindings: Binding[]): boolean {
  return bindings.some((b) => b.enabled() && b.keys!.includes(key));
}
