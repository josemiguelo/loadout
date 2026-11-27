// progress is how the commands that run steps (machine new, program install,
// script run, installer upgrade) say what they're doing: a step starts, a
// step ends, a phase begins. Plain, on any output, it prints a line when each
// step starts and one when it ends, with how long it took. As the inner
// loadout of a live run (live.ts, LOADOUT_LIVE=1) it writes only events, each
// an OSC sequence a terminal ignores, which the outer loadout reads out of
// the stream and draws.

import { echo, echoNoNewline } from "./spinner.ts";
import { Style } from "./style.ts";

/** StepKind is what a step is. */
export type StepKind = "program" | "script" | "configs" | "upgrade";

/** StepEnd is how a step ended. */
export type StepStatus = "ok" | "failed" | "skipped" | "done";

/** ProgressEvent is one event of a live run, as the inner loadout writes it. */
export type ProgressEvent =
  | { t: "start"; kind: StepKind; name: string; detail: string; index: number; total: number; phase: string }
  | { t: "end"; status: StepStatus; note: string; seconds: number }
  | { t: "phase"; name: string; note: string };

/** liveEnv is set on the inner loadout of a live run. */
export const liveEnv = "LOADOUT_LIVE";

const oscStart = "\x1b]777;loadout;";
const oscEnd = "\x07";

/** encodeEvent is ev as the OSC sequence the inner loadout writes. */
export function encodeEvent(ev: ProgressEvent): string {
  return oscStart + JSON.stringify(ev) + oscEnd;
}

/**
 * EventParser takes the inner loadout's output in chunks and splits it into
 * text and events, holding a sequence cut between two chunks until its end
 * arrives. Text that only looks like the start of one is passed on once it's
 * clearly not.
 */
export class EventParser {
  private held = "";

  /** feed is chunk's pieces in order: strings (text for the terminal) and events. */
  feed(chunk: string): (string | ProgressEvent)[] {
    let s = this.held + chunk;
    this.held = "";
    const out: (string | ProgressEvent)[] = [];
    for (;;) {
      const at = s.indexOf(oscStart);
      if (at < 0) {
        // A tail that could still become oscStart waits for the next chunk.
        const keep = partialPrefix(s, oscStart);
        if (s.length - keep > 0) out.push(s.slice(0, s.length - keep));
        this.held = s.slice(s.length - keep);
        return out;
      }
      if (at > 0) out.push(s.slice(0, at));
      const end = s.indexOf(oscEnd, at + oscStart.length);
      if (end < 0) {
        this.held = s.slice(at);
        return out;
      }
      const body = s.slice(at + oscStart.length, end);
      try {
        out.push(JSON.parse(body) as ProgressEvent);
      } catch {
        // Not ours after all: let the terminal have it.
        out.push(s.slice(at, end + 1));
      }
      s = s.slice(end + 1);
    }
  }
}

/** partialPrefix is how many trailing characters of s begin prefix. */
function partialPrefix(s: string, prefix: string): number {
  for (let n = Math.min(prefix.length - 1, s.length); n > 0; n--) {
    if (s.endsWith(prefix.slice(0, n))) return n;
  }
  return 0;
}

/** duration is seconds as "41s", "4m12s", "1h03m". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m" + String(s % 60).padStart(2, "0") + "s";
  return Math.floor(s / 3600) + "h" + String(Math.floor((s % 3600) / 60)).padStart(2, "0") + "m";
}

/** endLine is a step end as its line: a mark, the name, a few words and how long it took. */
export function endLine(name: string, status: StepStatus, note: string, seconds: number): string {
  const time = status === "ok" || status === "failed" ? "  " + Style.dim(duration(seconds)) : "";
  const words = note === "" ? "" : "  " + Style.dim(note);
  switch (status) {
    case "ok":
      return " " + Style.ok("✔") + " " + name + words + time;
    case "failed":
      return " " + Style.error("✘") + " " + name + words + time;
    case "done":
      return " " + Style.ok("✔") + " " + Style.dim(name) + words;
    case "skipped":
      return " " + Style.warn("–") + " " + Style.dim(name) + words;
  }
}

/** Progress counts a command's steps and reports each one, plainly or as events. */
export class Progress {
  private index = 0;
  private started = 0;
  private current = "";
  private readonly live = process.env[liveEnv] === "1";

  constructor(private total: number) {}

  /** start says the next step starts: name, and what it runs (detail). */
  start(kind: StepKind, name: string, detail = "", phase = ""): void {
    this.index++;
    this.started = performance.now();
    this.current = name;
    if (this.live) {
      echoNoNewline(encodeEvent({ t: "start", kind, name, detail, index: this.index, total: this.total, phase }));
      return;
    }
    const count = Style.dim(this.index + "/" + this.total);
    echo("\n" + Style.accent("━━") + " " + count + " " + Style.bold(name) + (detail === "" ? "" : "  " + Style.dim(detail)));
  }

  /** end says the step that started last ended: how, and in a few words why. */
  end(status: StepStatus, note = ""): void {
    const seconds = (performance.now() - this.started) / 1000;
    if (this.live) {
      echoNoNewline(encodeEvent({ t: "end", status, note, seconds }));
      return;
    }
    echo(endLine(this.current, status, note, seconds));
  }

  /** skip is a step that never starts: start and end at once. */
  skip(kind: StepKind, name: string, note: string, phase = ""): void {
    if (this.live) {
      this.start(kind, name, "", phase);
      this.end("skipped", note);
      return;
    }
    this.index++;
    echo(endLine(name, "skipped", note, 0));
  }

  /** phase says a phase begins: its name, and what it means. */
  phase(name: string, note: string): void {
    if (this.live) {
      echoNoNewline(encodeEvent({ t: "phase", name, note }));
      return;
    }
    echo("\n" + Style.header("── " + name) + (note === "" ? "" : Style.dim(" (" + note + ")")));
  }
}
