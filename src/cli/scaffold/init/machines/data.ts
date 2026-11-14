// Every per-machine setting, with its default: the data every machine
// carries (dotfile templates read it too). A machine sets its own with
// `data: { work: true }`, checked against this schema's type.
import { flag } from "loadout";

export const schema = {
  // A work machine.
  work: flag(false),
};

export type Data = typeof schema;
