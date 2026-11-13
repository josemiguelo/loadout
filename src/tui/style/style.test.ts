import { describe, expect, test } from "bun:test";
import { newBinding } from "../key.ts";
import { ResetStyle, strip } from "./ansi.ts";
import * as charmtone from "./charmtone.ts";
import * as style from "./index.ts";
import type { Color } from "./lipgloss.ts";
import { Focus, Status, ToastKind, type Span, type Theme } from "./index.ts";

const plain = (s: string) => strip(s);
const plainLines = (lines: readonly string[] | null) => (lines ?? []).map(strip).join("\n");
const widthIs = (s: string, want: number) => expect({ w: style.width(s), s: plain(s) }).toEqual({ w: want, s: plain(s) });

const themes: Record<string, Theme> = { dark: style.dark(), light: style.light() };

// --- contrast ---------------------------------------------------------

test("contrast helper matches WCAG", () => {
  const black = { r: 0, g: 0, b: 0 };
  const white = { r: 255, g: 255, b: 255 };
  const bw = style.contrast(black, white);
  expect(bw).toBeGreaterThanOrEqual(20.99);
  expect(bw).toBeLessThanOrEqual(21.01);
  expect(style.contrast(white, white)).toBe(1);
  // #777777 on white is the textbook 4.48.
  const g = style.contrast({ r: 0x77, g: 0x77, b: 0x77 }, white);
  expect(g).toBeGreaterThanOrEqual(4.47);
  expect(g).toBeLessThanOrEqual(4.49);
});

interface Pair {
  name: string;
  fg: Color;
  bg: Color;
  min: number;
}

function pairsOf(th: Theme): Pair[] {
  return [
    { name: "FgBase", fg: th.fgBase, bg: th.bgBase, min: 4.5 },
    { name: "FgSubtle", fg: th.fgSubtle, bg: th.bgBase, min: 4.5 },
    { name: "FgMoreSubtle", fg: th.fgMoreSubtle, bg: th.bgBase, min: 4.5 },
    { name: "FgMostSubtle (hints)", fg: th.fgMostSubtle, bg: th.bgBase, min: 3 },
    { name: "Primary (titles, bar)", fg: th.primary, bg: th.bgBase, min: 3 },
    { name: "Secondary (gradient end)", fg: th.secondary, bg: th.bgBase, min: 3 },
    { name: "Success", fg: th.success, bg: th.bgBase, min: 4.5 },
    { name: "SuccessSubtle", fg: th.successSubtle, bg: th.bgBase, min: 4.5 },
    { name: "Warning", fg: th.warning, bg: th.bgBase, min: 4.5 },
    { name: "Attention", fg: th.attention, bg: th.bgBase, min: 4.5 },
    { name: "Busy", fg: th.busy, bg: th.bgBase, min: 4.5 },
    { name: "Error", fg: th.error, bg: th.bgBase, min: 3 },
    { name: "Destructive", fg: th.destructive, bg: th.bgBase, min: 4.5 },
    { name: "Info", fg: th.info, bg: th.bgBase, min: 4.5 },
    { name: "selected row: OnPrimary on Primary", fg: th.onPrimary, bg: th.primary, min: 4.5 },
    { name: "selected blurred: FgSubtle on BgLess", fg: th.fgSubtle, bg: th.bgLess, min: 4.5 },
    { name: "blurred button: FgBase on BgLess", fg: th.fgBase, bg: th.bgLess, min: 4.5 },
    { name: "focused button: OnPrimary on Secondary", fg: th.onPrimary, bg: th.secondary, min: 3 },
    { name: "OKAY! badge", fg: style.ink(th, th.success), bg: th.success, min: 3 },
    { name: "WARNING badge", fg: style.ink(th, th.warning), bg: th.warning, min: 3 },
    { name: "ERROR badge", fg: style.ink(th, th.destructive), bg: th.destructive, min: 3 },
    { name: "HEY! badge", fg: style.ink(th, th.info), bg: th.info, min: 3 },
  ];
}

// Pantera is the spec's palette as Crush ships it: these pairs fall short of
// the bar and are kept on purpose (named here so a change is deliberate).
const darkExceptions: Record<string, number> = {
  FgMoreSubtle: 4.4, // Squid: Crush's secondary text
  "FgMostSubtle (hints)": 2.6, // Oyster: decoration-level hints
  Error: 4.29, // Sriracha: used with ×, never alone
  "focused button: OnPrimary on Secondary": 2.41, // Butter on Dolly, per spec
};

test("themes meet contrast", () => {
  const short: string[] = [];
  for (const [name, th] of Object.entries(themes)) {
    for (const p of pairsOf(th)) {
      const r = style.contrast(p.fg, p.bg);
      let want = p.min;
      const floor = darkExceptions[p.name];
      if (floor !== undefined && th.dark) want = floor - 0.01;
      if (r < want) short.push(`${name} ${p.name}: ${style.hex(p.fg)} on ${style.hex(p.bg)} = ${r.toFixed(2)}, want ≥ ${want}`);
    }
  }
  expect(short).toEqual([]);
});

test("light needs no exceptions", () => {
  const short = pairsOf(style.light())
    .filter((p) => style.contrast(p.fg, p.bg) < p.min)
    .map((p) => p.name);
  expect(short).toEqual([]);
});

test("toast titles read on the background", () => {
  // A card has no fill: its coloured title sits on the terminal's own
  // background, which the theme's BgBase stands for.
  for (const th of Object.values(themes)) {
    for (const k of [ToastKind.OK, ToastKind.Warning, ToastKind.Error, ToastKind.Hey]) {
      const [hue] = style.toastHue(th, k);
      expect(style.contrast(hue, th.bgBase)).toBeGreaterThanOrEqual(3);
    }
  }
});

test("ink picks the readable one", () => {
  const th = style.dark();
  expect(style.ink(th, charmtone.Charple)).toBe(th.onPrimary);
  const got = style.ink(th, charmtone.Citron);
  expect(style.contrast(got, charmtone.Citron)).toBeGreaterThanOrEqual(4.5);
});

test("deepen keeps hue and reaches target", () => {
  const bg = charmtone.Salt;
  const d = style.deepen(charmtone.Mustard, bg, 4.5);
  expect(style.contrast(d, bg)).toBeGreaterThanOrEqual(4.5);
  expect(d.r > d.b && d.g > d.b).toBe(true); // still yellowish
  expect(style.deepen(charmtone.Pepper, bg, 4.5)).toBe(charmtone.Pepper); // a colour already there comes back as is
});

// --- layout -----------------------------------------------------------

test("section header widths", () => {
  const th = style.dark();
  expect(plain(style.section(th, "Machine", "", 20))).toBe("Machine ────────────");
  expect(plain(style.section(th, "Runs", "2", 20))).toBe("Runs ───────────── 2");
  expect(plain(style.section(th, "Runs", "2 running", 12))).toBe("Runs ───────"); // info dropped when narrow
  expect(plain(style.section(th, "Machine", "", 5))).toBe("Mach…"); // title cut
  for (let w = 0; w <= 40; w++) widthIs(style.section(th, "Machine", "5 ok", w), w);
});

test("title row", () => {
  const th = style.dark();
  expect(plain(style.titleRow(th, "Remote", "135 updates", 30))).toBe("Remote             135 updates");
  expect(plain(style.titleRow(th, "Upgrade", "", 12))).toBe("Upgrade     ");
  expect(plain(style.titleRow(th, "Remote", "135 updates", 12))).toBe("Remote      "); // info dropped when tight
  for (let w = 0; w <= 60; w++) widthIs(style.titleRow(th, "Remote", "135 updates · 3 ticked", w), w);
  expect(style.titleRow(th, "Remote", "x", 30)).not.toContain("╱"); // no hatch
});

test("subject row aligns summary right", () => {
  const th = style.dark();
  const g = style.renderSpan(th, style.statusGlyph(th, Status.OK));
  expect(plain(style.subjectRow(th, g, "programs", "69/69", Focus.Unselected, 30))).toBe("  ✓ programs             69/69");
  expect(plain(style.subjectRow(th, g, "remote", "135", Focus.SelectedFocused, 30))).toBe("  ✓ remote                 135");
  // the focused subject sits on a Primary fill, like the main pane's selected row
  expect(style.subjectRow(th, g, "remote", "135", Focus.SelectedFocused, 30)).toContain("48;2;107;80;255");
  // an unselected subject has no fill
  expect(style.subjectRow(th, g, "programs", "69/69", Focus.Unselected, 30)).not.toContain("48;2");
  expect(plain(style.subjectRow(th, g, "configs", "2 drifted, 1 edited", Focus.Unselected, 20))).toBe("  ✓ configs 2 drift…"); // summary cut first
  expect(plain(style.subjectRow(th, g, "programs", "69/69", Focus.Unselected, 10))).toBe("  ✓ progr…"); // name cut last
  for (let w = 0; w <= 40; w++) widthIs(style.subjectRow(th, g, "programs", "69/69", Focus.SelectedBlurred, w), w);
});

test("list row states", () => {
  const th = style.dark();
  const left: Span[] = [style.tick(th, true), style.s(" 1password")];
  const right: Span[] = [style.s("8.12.40 → 8.12.42")];
  expect(plain(style.listRow(th, left, right, Focus.Unselected, 36))).toBe(" ◉ 1password      8.12.40 → 8.12.42 ");
  expect(plain(style.listRow(th, left, right, Focus.SelectedFocused, 20))).toBe(" ◉ 1password 8.12.… ");
  for (const f of [Focus.Unselected, Focus.SelectedFocused, Focus.SelectedBlurred]) {
    for (let w = 0; w <= 40; w++) widthIs(style.listRow(th, left, right, f, w), w);
  }
  // focused selection must paint Primary behind the row
  expect(style.listRow(th, left, right, Focus.SelectedFocused, 36)).toContain("48;2;107;80;255");
  // fuzzy matches must be underlined
  const matched = style.listRow(th, [{ text: "brew", matches: [0, 2] }], [], Focus.Unselected, 10);
  expect(matched).not.toBe(style.listRow(th, [{ text: "brew" }], [], Focus.Unselected, 10));
  expect(matched).toContain("\x1b[4;");
});

test("scrollbar", () => {
  const th = style.dark();
  const col = (total: number, visible: number, offset: number) => plainLines(style.scrollbar(th, 5, total, visible, offset));
  expect(col(3, 5, 0)).toBe(" \n \n \n \n "); // fits
  expect(col(20, 5, 0)).toBe("┃\n│\n│\n│\n│"); // top
  expect(col(20, 5, 15)).toBe("│\n│\n│\n│\n┃"); // bottom
  expect(col(100, 5, 1)).toBe("│\n┃\n│\n│\n│"); // nudged
});

test("truncation never exceeds width", () => {
  for (let w = 0; w < 12; w++) widthIs(style.fit("loadout · hello", w), w);
  expect(style.truncate("abcdef", 4)).toBe("abc…");
});

// --- logo ---------------------------------------------------------------

test("title row focused is the selected row's highlight", () => {
  const th = style.dark();
  const row = style.titleRowFocused(th, "Run", "loadout install x --yes ✓ done 4s", 50);
  widthIs(row, 50);
  expect(row).toContain("48;2;107;80;255"); // the focused title sits on the Primary fill
  expect(plain(row)).toBe(plain(style.listRow(th, [{ text: "Run", bold: true }], [style.s("loadout install x --yes ✓ done 4s")], Focus.SelectedFocused, 50)));
  expect(style.titleRowMuted(th, "Run", "x", 50)).not.toContain("48;2"); // a muted title has no fill
});

test("sidebar logo", () => {
  const th = style.dark();
  expect(plainLines(style.sidebarLogo(th, "v4.0.0", 32))).toBe("loadout" + " ".repeat(19) + "v4.0.0");
  expect(plain(style.sidebarLogo(th, "v4.0.0-SNAPSHOT+abcdef", 20)[0]!)).toBe("loadout v4.0.0-SNAP…"); // long version cut
  expect(plain(style.sidebarLogo(th, "v4.0.0", 8)[0]!)).toBe("loadout "); // no room for the version
  for (let w = 0; w <= 40; w++) for (const l of style.sidebarLogo(th, "v4.0.0", w)) widthIs(l, w);
  expect(style.sidebarLogo(th, "v", 32)[0]).toContain("\x1b[1;"); // the name is bold
});

test("one line logo and breadcrumb", () => {
  const th = style.dark();
  const words = (s: string) => plain(s).split(/\s+/).filter(Boolean).join(" ");
  expect(plain(style.oneLineLogo(th, 14))).toBe("loadout       ");
  for (let w = 0; w <= 20; w++) widthIs(style.oneLineLogo(th, w), w);
  const b = style.breadcrumb(th, ["programs", "inspect", "git"], ["⟳ run pull", "✓2 ●3"], 80);
  widthIs(b, 80);
  expect(words(b)).toBe("loadout › programs › inspect › git ⟳ run pull ✓2 ●3");
  // the right's parts drop from the end
  expect(words(style.breadcrumb(th, ["programs"], ["⟳ run pull", "✓2 ●3"], 36))).toBe("loadout › programs ⟳ run pull");
  for (let w = 0; w <= 80; w++) widthIs(style.breadcrumb(th, ["t2-macbook-omarchy"], ["⟳ install kitty", "✓2 ●3"], w), w);
});

// --- dialog -------------------------------------------------------------

test("dialog frame", () => {
  const th = style.dark();
  const d: style.Dialog = {
    title: "Upgrade",
    info: "2 steps",
    body: ["omarchy   omarchy update -y", "brew      brew upgrade"],
    buttons: ["Run", "Cancel"],
    focused: 0,
    help: "←→ choose • enter press • esc cancel",
  };
  expect(plainLines(style.renderDialog(d, th, 120, 40))).toBe(
    [
      "╭──────────────────────────────────────╮",
      "│ Upgrade                      2 steps │",
      "│                                      │",
      "│ omarchy   omarchy update -y          │",
      "│ brew      brew upgrade               │",
      "│                                      │",
      "│                    Run      Cancel   │",
      "│                                      │",
      "│ ←→ choose • enter press • esc cancel │",
      "╰──────────────────────────────────────╯",
    ].join("\n"),
  );

  // Caps: 70 wide, 20 tall by default; the body is cut, never the frame.
  const long: style.Dialog = { title: "List", body: Array.from({ length: 50 }, () => "x".repeat(200)) };
  const lines = style.renderDialog(long, th, 200, 60)!;
  expect(lines.length).toBe(style.DialogMaxHeight);
  for (const l of lines) widthIs(l, style.DialogMaxWidth);
  long.maxWidth = style.DialogWideMaxWidth;
  widthIs(style.renderDialog(long, th, 200, 60)![0]!, style.DialogWideMaxWidth);
  // The screen caps too.
  const small = style.renderDialog(long, th, 30, 8)!;
  expect(small.length).toBeLessThanOrEqual(8);
  for (const l of small) widthIs(l, 30);
});

test("overlay placement", () => {
  const bg = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd"];
  const fg = ["XX", "YY"];
  expect(plainLines(style.overlay(bg, fg, 3, 1))).toBe("aaaaaaaaaa\nbbbXXbbbbb\ncccYYccccc\ndddddddddd");
  expect(plainLines(style.center(bg, fg, 10, 4))).toBe("aaaaaaaaaa\nbbbbXXbbbb\nccccYYcccc\ndddddddddd");
  expect(plainLines(style.overlay(["ab"], ["Z"], 4, 0))).toBe("ab  Z"); // past short lines
  expect(plainLines(style.overlay(["ab"], ["Z"], 0, 2))).toBe("ab\n\nZ"); // past the bottom
  // a wide rune split by the edge leaves a space, never a shifted row
  expect(plainLines(style.overlay(["世界世界"], ["Z"], 1, 0))).toBe(" Z界世界");
  expect(plainLines(style.overlay(["世界世界"], ["Z"], 0, 0))).toBe("Z 界世界");
  // styles of the background don't leak into the overlay and resume after
  const out = style.overlay([style.fg(charmtone.Coral, "rrrrrrrr")], ["Z"], 2, 0)[0]!;
  expect(plain(out)).toBe("rrZrrrrr");
  expect(out).toContain(ResetStyle + "Z"); // overlay must reset before its own cells
});

// --- status ---------------------------------------------------------------

test("help line", () => {
  const th = style.dark();
  const b = [
    newBinding({ keys: ["ctrl+]"], help: ["ctrl+]", "dashboard"] }),
    newBinding({ keys: ["ctrl+c"], help: ["ctrl+c", "interrupt"] }),
    newBinding({ keys: ["ctrl+g"], help: ["ctrl+g", "help"] }),
  ];
  expect(plain(style.helpLine(th, b, 80))).toBe(" ctrl+] dashboard • ctrl+c interrupt • ctrl+g help");
  expect(style.width(style.helpLine(th, b, 30))).toBeLessThanOrEqual(30);
  expect(plain(style.fullHelp(th, [b.slice(0, 2), b.slice(2)], 80))).toBe("ctrl+] dashboard    ctrl+g help\nctrl+c interrupt               ");
});

test("toast card and expiry", async () => {
  const th = style.dark();
  const m = new style.Toasts();
  m.ttl = 5;
  const first = m.show(ToastKind.OK, "synced");
  expect(plainLines(m.card(th, 80))).toBe(["╭────────╮", "│ ✓ Done │", "│ synced │", "╰────────╯"].join("\n"));
  const second = m.show(ToastKind.Error, "a command is running");
  // The first toast's timer fires: the second keeps showing.
  expect(m.update(await first())).toBe(true);
  expect(m.active()).toBe(true); // an older toast's expiry must not take the new one down
  const msg = await second();
  expect(msg).toBeInstanceOf(style.ToastExpiredMsg);
  m.update(msg);
  expect(m.active()).toBe(false); // the toast must expire
  expect(m.card(th, 80)).toBeNull();
  expect(m.update("other")).toBe(false); // only toast messages are the toast's
});

test("toast card wraps, fits and paints no background", () => {
  const th = style.dark();
  const long = "configs not checked: chezmoi could not read the source state because a template failed to render";
  const card = style.toastCard(th, ToastKind.Warning, long, 40)!;
  const w = style.width(card[0]!);
  for (const l of card) {
    widthIs(l, w);
    expect(l).not.toContain("48;2");
  }
  expect(w).toBeLessThanOrEqual(40);
  const title = (c: string[] | null) => plain(c![1]!).replace(/^│+|│+$/g, "").trim();
  expect(title(card)).toBe("! Warning");
  expect(card.length).toBeLessThanOrEqual(2 + 1 + style.toastLines);
  expect([title(style.toastCard(th, ToastKind.Error, "x", 40)), title(style.toastCard(th, ToastKind.Hey, "x", 40))].join(" / ")).toBe("× Error / • Note");
  expect(style.toastCard(th, ToastKind.OK, "x", 6)).toBeNull(); // no card where none fits
});

// --- animation --------------------------------------------------------

test("busy clock stops when nothing is busy", async () => {
  const b = style.newBusy();
  b.interval = 1;
  expect(b.sync(false)).toBeNull(); // idle: no ticking
  expect(b.running()).toBe(false);
  const cmd = b.sync(true);
  expect(cmd).not.toBeNull(); // busy: the clock starts
  expect(b.running()).toBe(true);
  expect(b.sync(true)).toBeNull(); // one clock: starting a running clock adds no second timer
  const [next, ok] = b.update(await cmd!());
  expect([ok, next !== null, b.frame()]).toEqual([true, true, 1]); // a tick advances and schedules the next
  b.sync(false);
  const stale = await next!(); // a tick command fires once
  const [again, ok2] = b.update(stale);
  expect([ok2, again]).toEqual([true, null]); // stopped: the pending tick is dropped and nothing more is scheduled
  expect(b.frame()).toBe(1); // a stopped clock doesn't advance
  // Restarted: the old generation's tick still does nothing.
  const restart = b.sync(true)!;
  expect(b.update(stale)[0]).toBeNull(); // a stale tick after a restart must not double the clock
  const fresh = await restart();
  expect(b.update(fresh)[0]).not.toBeNull(); // the new tick keeps going
  b.sync(false);
  expect(style.newBusy().update(fresh)[1]).toBe(false); // another clock's tick isn't mine
});

test("busy glyph is a braille spinner", () => {
  const th = style.dark();
  const seen = new Set<string>();
  for (let f = 0; f < 10; f++) {
    const g = plain(style.busyGlyph(th, f));
    widthIs(style.busyGlyph(th, f), 1);
    expect("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏").toContain(g);
    seen.add(g);
  }
  expect(seen.size).toBe(10); // every frame shows
  expect(plain(style.busyGlyph(th, 0))).toBe(plain(style.busyGlyph(th, 10))); // it loops
  expect(plain(style.busyLabel(th, 2, "checking…"))).toBe("⠹ checking…");
});

test("canvas", () => {
  expect(plainLines(style.canvas(["abc", "toolong"], 4, 3))).toBe("abc \ntoo…\n    ");
});

describe("display widths", () => {
  test("wide and emoji graphemes take two cells, combining marks none", () => {
    expect(style.width("世界")).toBe(4);
    expect(style.width("🎉👍🏽")).toBe(4);
    expect(style.width("é")).toBe(1);
    expect(style.width("\x1b[31mred\x1b[m")).toBe(3);
  });
});
