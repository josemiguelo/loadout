// Every per-machine setting, with its default: the data every machine
// carries (dotfile templates read it too). A machine sets its own with
// `data: { work: true }`, checked against this schema's type.

export const schema = {
  // A work machine.
  work: false,
};

export type Data = typeof schema;
