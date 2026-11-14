import { afterEach, expect, test } from "bun:test";
import { strip, stringWidth } from "../style/ansi.ts";
import { KeyEnter, KeyPressMsg, ModCtrl, type Cmd, type Msg } from "../messages.ts";
import { BellMsg, ExitMsg, Model, ScrollbackLines } from "./term.ts";

// harness drives one terminal the way the screen would: it runs the pending
// command, feeds its message to update and keeps the next command.
class Harness {
  msgs: Msg[] = [];
  constructor(
    readonly m: Model,
    public cmd: Cmd | null,
  ) {}

  /** next runs the pending command (5s cap) and feeds its message to update. */
  async next(): Promise<Msg> {
    if (!this.cmd) throw new Error(`no pending command; screen:\n${this.m.plainText()}`);
    const msg = await Promise.race([this.cmd(), Bun.sleep(5000).then(() => Promise.reject(new Error(`no message in 5s; screen:\n${this.m.plainText()}`)))]);
    this.msgs.push(msg);
    this.cmd = this.m.update(msg);
    return msg;
  }

  async until(cond: () => boolean): Promise<void> {
    while (!cond()) await this.next();
  }

  waitText(s: string): Promise<void> {
    return this.until(() => this.m.plainText().includes(s));
  }

  waitExit(): Promise<void> {
    return this.until(() => this.m.hasExited());
  }

  keys(s: string): void {
    for (const r of s) this.m.update(new KeyPressMsg(r.codePointAt(0)!, r));
  }

  key(k: KeyPressMsg): void {
    this.m.update(k);
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function start(w: number, h: number, script: string): Harness {
  const m = new Model(w, h);
  cleanups.push(() => m.close());
  m.focus();
  return new Harness(m, m.start({ argv: ["sh", "-c", script] }));
}

const enter = new KeyPressMsg(KeyEnter);
const ctrlC = new KeyPressMsg("c".codePointAt(0)!, "", ModCtrl);
const top = (v: string) => strip(v).split("\n")[0]!.trim();

test("coloured output lands in view", async () => {
  const h = start(40, 5, `printf '\\033[31mred\\033[0m plain\\n'`);
  await h.waitExit();
  const v = h.m.view();
  expect(strip(v)).toContain("red plain");
  expect(v).toContain("\x1b[31mred");
  const lines = v.split("\n");
  expect([lines.length, stringWidth(lines[0]!), stringWidth(lines[4]!)]).toEqual([5, 40, 40]);
  expect([h.m.exitCode(), h.m.interrupted()]).toEqual([0, false]);
});

test("carriage return overwrites progress", async () => {
  const h = start(40, 5, `printf 'progress 1'; sleep 0.1; printf '\\rprogress 2'; sleep 0.1; printf '\\rdone      \\n'`);
  await h.waitExit();
  expect(h.m.plainText()).toBe("done");
});

test("read gets forwarded keys", async () => {
  const h = start(40, 5, `printf 'name? '; read a; echo "got $a"`);
  await h.waitText("name?");
  h.keys("xy");
  h.key(enter);
  await h.waitText("got xy");
});

test("/dev/tty prompt uses the PTY", async () => {
  const h = start(40, 5, `exec </dev/null >/dev/null; printf 'pw: ' >/dev/tty; read p </dev/tty; echo "ok $p" >/dev/tty`);
  await h.waitText("pw:");
  h.keys("s3");
  h.key(enter);
  await h.waitText("ok s3");
});

test("Ctrl-C interrupts the child", async () => {
  const h = start(40, 5, `echo ready; sleep 30; echo not-reached`);
  await h.waitText("ready");
  h.key(ctrlC);
  await h.waitExit();
  expect([h.m.interrupted(), h.m.exitCode()]).toEqual([true, 130]);
});

test("interrupt signals the group and exit 130 is interrupted", async () => {
  const h = start(40, 5, `trap 'echo trapped; exit 130' INT; echo ready; while :; do sleep 0.1; done`);
  await h.waitText("ready");
  h.m.interrupt();
  await h.waitExit();
  expect(h.m.interrupted()).toBe(true);
  expect(h.m.plainText()).toContain("trapped");
});

test("exit code is reported", async () => {
  const h = start(40, 5, `echo bye; exit 3`);
  await h.waitExit();
  const last = h.msgs[h.msgs.length - 1] as ExitMsg;
  expect([h.m.exitCode(), h.m.interrupted(), last.code, last.err]).toEqual([3, false, 3, null]);
  // The last output is in before the exit.
  expect(h.m.plainText()).toContain("bye");
});

test("start failure is an exit", async () => {
  const m = new Model(10, 2);
  const msg = await m.start({ argv: ["/nonexistent/loadout-test"] })();
  expect(msg).toBeInstanceOf(ExitMsg);
  const e = msg as ExitMsg;
  expect([e.err !== null, e.code, m.hasExited()]).toEqual([true, -1, true]);
  await m.close();
});

test("resize reaches the child", async () => {
  const h = start(40, 5, `stty size; echo ready; read x; stty size`);
  await h.waitText("ready");
  h.m.resize(50, 12);
  h.key(enter);
  await h.waitExit();
  const p = h.m.plainText();
  expect(p).toContain("5 40");
  expect(p).toContain("12 50");
});

test("colour queries are answered with the theme's colours", async () => {
  const h = start(60, 5, `stty -icanon -echo min 0 time 20; printf '\\033]11;?\\007'; r=$(dd bs=64 count=1 2>/dev/null); printf '%s\\n' "$r" | tr -d '\\033\\007'`);
  h.m.setColors({ r: 0xab, g: 0xcd, b: 0xef }, { r: 0x12, g: 0x34, b: 0x56 });
  await h.waitExit();
  expect(h.m.plainText()).toContain("rgb:1212/3434/5656");
});

test("title and bell", async () => {
  const h = start(40, 5, `printf '\\033]0;hello\\007'; sleep 0.1; printf '\\a'; sleep 0.1; echo x`);
  await h.waitExit();
  expect(h.m.title()).toBe("hello");
  expect(h.msgs.some((m) => m instanceof BellMsg)).toBe(true);
});

test("a grown panel pulls its output down instead of leaving blank rows", async () => {
  const h = start(20, 10, `seq 1 30`);
  await h.waitExit();
  h.m.resize(20, 25); // z zooms the panel
  const rows = strip(h.m.view()).split("\n");
  expect(rows.length).toBe(25);
  expect(rows[0]!.trim()).toBe("7"); // the scrollback comes down into the new rows
  expect(rows[23]!.trim()).toBe("30"); // the output ends at the bottom, above the cursor's row
  expect(rows.slice(0, 24).filter((r) => r.trim() === "")).toEqual([]); // no blank row inside the output
  h.m.scrollUp(3);
  expect(top(h.m.view())).toBe("4");
  h.m.top();
  expect(top(h.m.view())).toBe("1"); // top shows the start of the output
  h.m.bottom();
  expect(top(h.m.view())).toBe("7"); // bottom is the live view again
});

test("scrollback scrolls and plain keeps everything after close", async () => {
  const h = start(20, 10, `seq 1 300`);
  await h.waitExit();
  expect(top(h.m.view())).toBe("292"); // the cursor sits on an empty last line
  h.m.scrollUp(5);
  expect(top(h.m.view())).toBe("287");
  for (let i = 0; i < 100; i++) h.m.pageUp();
  expect(top(h.m.view())).toBe("1");
  h.m.bottom();
  await h.m.close();
  const want = Array.from({ length: 300 }, (_, i) => String(i + 1)).join("\n");
  expect(h.m.plainText()).toBe(want);
  const v = h.m.view().split(/\s+/).filter(Boolean);
  expect([v.length, v[0], v[9]]).toEqual([10, "291", "300"]);
  h.m.scrollUp(1000);
  expect(h.m.view().split(/\s+/).filter(Boolean)[0]).toBe("1");
  expect([h.m.hasExited(), h.m.exitCode()]).toEqual([true, 0]);
});

test("scrollback is bounded", async () => {
  const h = start(20, 5, `seq 1 ${ScrollbackLines + 500}`);
  await h.waitExit();
  expect(h.m.plainText().split("\n").length).toBeLessThanOrEqual(ScrollbackLines + 5);
});

test("two terminals' messages don't mix", async () => {
  const a = start(20, 3, `echo aaa; exit 1`);
  const b = start(20, 3, `echo bbb; exit 2`);
  expect(a.m.ID()).not.toBe(b.m.ID());
  // Every message goes to both models, as a parent broadcasting would.
  while (!a.m.hasExited() || !b.m.hasExited()) {
    for (const h of [a, b]) {
      if (!h.cmd) continue;
      const msg = await h.next();
      const other = h === a ? b : a;
      expect(other.m.update(msg)).toBeNull(); // a message for the other terminal returns no command
    }
  }
  expect([a.m.exitCode(), b.m.exitCode()]).toEqual([1, 2]);
  expect([a.m.plainText(), b.m.plainText()]).toEqual(["aaa", "bbb"]);
});

test("keys go nowhere unless focused", async () => {
  const h = start(40, 5, `printf 'name? '; read a; echo "got $a"`);
  await h.waitText("name?");
  h.m.blur();
  h.keys("no");
  h.m.focus();
  h.keys("yes");
  h.key(enter);
  await h.waitText("got ");
  expect(h.m.plainText()).toContain("got yes");
});

test("close kills the child and leaves nothing waiting", async () => {
  const pids: number[] = [];
  for (const script of [
    `echo done`,
    `echo ready; sleep 30`,
    `trap '' HUP; echo ready; sleep 30`, // outlives SIGHUP: SIGKILL
    `sleep 30 & echo ready; wait`, // a grandchild holds the tty
    `printf 'q? '; read a`, // waits on input
    `echo ready; exec 0<&-; while :; do :; done`, // never reads its input
  ]) {
    const m = new Model(20, 3);
    const h = new Harness(m, m.start({ argv: ["sh", "-c", script] }));
    await h.until(() => m.plainText().includes("ready") || m.plainText().includes("?") || m.hasExited());
    m.focus();
    h.keys("x".repeat(10000)); // queued input a child may never read
    pids.push(m.pid());
    // A pending wait, as the screen would hold, must end on close.
    const pending = h.cmd ? h.cmd() : Promise.resolve(null);
    const began = performance.now();
    await m.close();
    expect(performance.now() - began).toBeLessThan(2500);
    const ended = await Promise.race([pending.then(() => true), Bun.sleep(1000).then(() => false)]);
    expect({ script, ended }).toEqual({ script, ended: true }); // pending command ends after close
    expect({ script, exited: m.hasExited() }).toEqual({ script, exited: true }); // an exit is recorded
    await m.close(); // idempotent
  }
  for (const pid of pids) {
    let gone = false;
    try {
      process.kill(pid, 0);
    } catch (e) {
      gone = (e as NodeJS.ErrnoException).code === "ESRCH";
    }
    expect({ pid, gone }).toEqual({ pid, gone: true });
  }
}, 30000);
