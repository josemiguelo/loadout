import { expect, test } from "bun:test";
import { Terminal as Emulator } from "@xterm/headless";
import { LiveView } from "./live.ts";
import { encodeEvent, EventParser, type ProgressEvent } from "./progress.ts";

const start = (name: string, index = 1, total = 3, detail = ""): string =>
  encodeEvent({ t: "start", kind: "program", name, detail, index, total, phase: "core" });
const end = (status: "ok" | "failed" | "done" | "skipped", note = "", seconds = 2): string => encodeEvent({ t: "end", status, note, seconds });

test("events are read out of the stream, even cut between chunks", () => {
  const p = new EventParser();
  const ev: ProgressEvent = { t: "phase", name: "later", note: "" };
  const whole = "before" + encodeEvent(ev) + "after";
  const pieces: (string | ProgressEvent)[] = [];
  for (let i = 0; i < whole.length; i += 7) pieces.push(...p.feed(whole.slice(i, i + 7)));
  expect(pieces.filter((x) => typeof x === "string").join("")).toBe("beforeafter");
  expect(pieces.filter((x) => typeof x !== "string")).toEqual([ev]);
});

test("text that only looks like an event reaches the terminal", () => {
  const p = new EventParser();
  expect(p.feed("a\x1b]777;loadout;not json\x07b").join("")).toBe("a\x1b]777;loadout;not json\x07b");
  expect(p.feed("ends with \x1b]7")).toEqual(["ends with "]);
  expect(p.feed("7 not ours")).toEqual(["\x1b]77 not ours"]);
});

/** A terminal the view draws on, and what's on its screen. */
async function screen(feed: (view: LiveView) => Promise<void>, cols = 60): Promise<{ lines: string[]; cursor: [number, number] }> {
  const term = new Emulator({ cols, rows: 40, scrollback: 1000, allowProposedApi: true });
  const writes: string[] = [];
  let clock = 0;
  const view = new LiveView(cols, 40, (s) => writes.push(s), () => clock++ * 1000);
  await feed(view);
  for (const w of writes) await new Promise<void>((done) => term.write(w, done));
  const b = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < b.length; y++) lines.push(b.getLine(y)!.translateToString(true).trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return { lines, cursor: [b.baseY + b.cursorY, b.cursorX] };
}

test("a finished step is one line; its output goes", async () => {
  const { lines } = await screen(async (v) => {
    await v.feed("Plan for m1:\r\n  + brave\r\n");
    await v.feed(start("brave", 1, 2, "[omarchy-aur] omarchy pkg aur add brave-bin"));
    await v.feed("downloading brave\r\nbuilding brave\r\n");
    await v.feed(end("ok", "1.84.2"));
    await v.finish();
  });
  expect(lines).toContain("Plan for m1:");
  expect(lines.some((l) => /✔ brave +1\.84\.2 +2s/.test(l))).toBe(true);
  expect(lines.join("\n")).not.toContain("downloading brave");
});

test("a failed step keeps its output, under the mark", async () => {
  const { lines } = await screen(async (v) => {
    await v.feed(start("code"));
    await v.feed("error: target not found: code\r\n");
    await v.feed(end("failed", "exit 1"));
    await v.finish();
  });
  const at = lines.findIndex((l) => l.includes("error: target not found: code"));
  expect(at).toBeGreaterThanOrEqual(0);
  expect(lines[at]).toMatch(/^ {2}│ error/);
  expect(lines[at + 1]).toMatch(/✘ code +exit 1 +2s/);
});

test("the running step shows a spinner, its name, where the run is, and its last lines", async () => {
  const { lines } = await screen(async (v) => {
    await v.feed(start("brave", 12, 57, "[omarchy-aur] omarchy pkg aur add brave-bin"));
    await v.feed(Array.from({ length: 15 }, (_, i) => "line " + (i + 1)).join("\r\n") + "\r\n");
    v.tick();
    await v.feed("");
  });
  const head = lines.find((l) => l.includes("brave"))!;
  expect(head).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] brave +\[omarchy-aur\]/);
  expect(head).toMatch(/12\/57 +\d+s$/);
  expect(lines).toContain("  │ … 5 more line(s)");
  expect(lines).toContain("  │ line 6");
  expect(lines).toContain("  │ line 15");
  expect(lines).not.toContain("  │ line 5");
});

test("a step's prompt is in the live lines, the cursor after it", async () => {
  const { lines, cursor } = await screen(async (v) => {
    await v.feed(start("atuin-login"));
    await v.feed("==> Log in to atuin.\r\nPlease enter username: ");
    v.tick();
    await v.feed("");
  });
  const at = lines.indexOf("  │ Please enter username:");
  expect(at).toBeGreaterThanOrEqual(0);
  expect(cursor).toEqual([at, "  │ Please enter username: ".length]);
});

test("between steps the output passes through, a prompt included", async () => {
  const { lines, cursor } = await screen(async (v) => {
    await v.feed("Plan for m1:\r\n  + brave\r\n\r\nProceed? [y/N] ");
    v.tick();
    await v.feed("");
  });
  expect(lines).toEqual(["Plan for m1:", "  + brave", "", "Proceed? [y/N]"]);
  expect(cursor).toEqual([3, "Proceed? [y/N] ".length]);
});

test("a phase is a heading of its own; a step done already and a skipped one are one line each", async () => {
  const { lines } = await screen(async (v) => {
    await v.feed(start("setup-git"));
    await v.feed(end("done", "already done"));
    await v.feed(encodeEvent({ t: "phase", name: "later: what can wait", note: "" }));
    await v.feed(start("big", 2, 2));
    await v.feed(end("skipped", "needs base, which didn't install"));
    await v.finish();
  });
  expect(lines.some((l) => /✔ setup-git +already done$/.test(l))).toBe(true);
  expect(lines).toContain("── later: what can wait");
  expect(lines.some((l) => /– big +needs base, which didn't install$/.test(l))).toBe(true);
});
