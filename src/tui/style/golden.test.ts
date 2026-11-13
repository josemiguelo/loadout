// The rendered bytes, compared with what the Go package (Lip Gloss) made
// for the same calls: testdata/golden.json was written by the Go reference
// over this same grid of themes, widths and states. Not a Go test: it pins
// the port to the look it reproduces.

import { describe, expect, test } from "bun:test";
import { newBinding } from "../key.ts";
import golden from "./testdata/golden.json" with { type: "json" };
import * as charmtone from "./charmtone.ts";
import * as style from "./index.ts";
import type { Span } from "./text.ts";

function render(): Map<string, string> {
  const out = new Map<string, string>();
  const put = (k: string, v: string) => out.set(k, v);
  const putL = (k: string, v: string[] | null) => out.set(k, v === null ? "<nil>" : v.join("\n"));
  for (const tn of ["dark", "light"]) {
    const th = style.themeFor(tn === "dark");
    const p = tn + "/";
    const tokens = {
      Primary: th.primary, Secondary: th.secondary, Accent: th.accent, BgBase: th.bgBase, BgLeast: th.bgLeast,
      BgLess: th.bgLess, BgMost: th.bgMost, Separator: th.separator, FgBase: th.fgBase, FgSubtle: th.fgSubtle,
      FgMoreSubtle: th.fgMoreSubtle, FgMostSubtle: th.fgMostSubtle, OnPrimary: th.onPrimary, Success: th.success,
      SuccessSubtle: th.successSubtle, Warning: th.warning, Attention: th.attention, Busy: th.busy, Error: th.error,
      Destructive: th.destructive, Info: th.info,
    };
    for (const [k, c] of Object.entries(tokens)) put(p + "color/" + k, style.hex(c));
    put(p + "ink/Success", style.hex(style.ink(th, th.success)));
    put(p + "ink/Citron", style.hex(style.ink(th, charmtone.Citron)));
    put(p + "mix", style.hex(style.mix(th.primary, th.bgBase, 0.3)));
    for (const w of [0, 1, 2, 3, 4, 5, 7, 9, 12, 16, 20, 25, 30, 34, 40]) {
      const ws = `/${w}`;
      put(p + "Section/a" + ws, style.section(th, "Machine", "", w));
      put(p + "Section/b" + ws, style.section(th, "Runs", "5 ok", w));
      put(p + "Section/c" + ws, style.section(th, "Runs", style.fg(th.success, "✓2"), w));
      put(p + "TitleRow/a" + ws, style.titleRow(th, "Remote", "", w));
      put(p + "TitleRow/b" + ws, style.titleRow(th, "Remote", "135 updates · 3 ticked", w));
      put(p + "TitleRowMuted" + ws, style.titleRowMuted(th, "Run", "x y", w));
      put(p + "TitleRowFocused" + ws, style.titleRowFocused(th, "Run", style.fg(th.success, "✓ done") + " 4s", w));
      const g = style.renderSpan(th, style.statusGlyph(th, style.Status.OK));
      for (let f = 0; f < 3; f++) {
        const fs = `/f${f}`;
        put(p + "SubjectRow/a" + fs + ws, style.subjectRow(th, g, "programs", "69/69", f, w));
        put(p + "SubjectRow/b" + fs + ws, style.subjectRow(th, style.busyGlyph(th, 3), "configs", "2 drifted, 1 edited", f, w));
        put(p + "SubjectRow/c" + fs + ws, style.subjectRow(th, "", "世界 wide", "🎉", f, w));
        const left: Span[] = [style.tick(th, true), style.s(" 1password")];
        const right: Span[] = [style.s("8.12.40 → 8.12.42")];
        put(p + "ListRow/a" + fs + ws, style.listRow(th, left, right, f, w));
        put(p + "ListRow/b" + fs + ws, style.listRow(th, [style.fold(th, false), { text: " brew", bold: true, matches: [1, 3] }, style.s(" x", th.warning)], [], f, w));
        put(p + "ListRow/c" + fs + ws, style.listRow(th, [style.statusGlyph(th, f + 3), style.s(" 世界世界abc")], [style.s("a", th.error), style.s("bcdef")], f, w));
      }
      put(p + "SidebarLogo/a" + ws, style.sidebarLogo(th, "v4.0.0", w).join("\n"));
      put(p + "SidebarLogo/b" + ws, style.sidebarLogo(th, "v4.0.0-SNAPSHOT+abcdef", w).join("\n"));
      put(p + "OneLineLogo" + ws, style.oneLineLogo(th, w));
      put(p + "Breadcrumb/a" + ws, style.breadcrumb(th, ["programs", "inspect", "git"], ["⟳ run pull", style.fg(th.success, "✓2") + " ●3"], w * 2));
      put(p + "Breadcrumb/b" + ws, style.breadcrumb(th, ["t2-macbook-omarchy"], [], w));
      put(p + "Canvas" + ws, style.canvas(["abc", style.fg(th.error, "toolong世界"), ""], Math.trunc(w / 2), Math.trunc(w / 8)).join("\n"));
      put(p + "ToastCard/ok" + ws, (style.toastCard(th, style.ToastKind.OK, "synced", w) ?? []).join("\n"));
      put(p + "ToastCard/warn" + ws, (style.toastCard(th, style.ToastKind.Warning, "configs not checked: chezmoi could not read the source state because a template failed to render", w) ?? []).join("\n"));
      put(p + "ToastCard/err" + ws, (style.toastCard(th, style.ToastKind.Error, "a command is running   now", w) ?? []).join("\n"));
      put(p + "ToastCard/hey" + ws, (style.toastCard(th, style.ToastKind.Hey, "supercalifragilisticexpialidocious-and-then-some-more-text-here word", w) ?? []).join("\n"));
      const b = [
        newBinding({ keys: ["ctrl+]"], help: ["ctrl+]", "dashboard"] }),
        newBinding({ keys: ["ctrl+c"], help: ["ctrl+c", "interrupt"] }),
        newBinding({ keys: ["x"], help: ["x", "hidden"], disabled: true }),
        newBinding({ keys: ["ctrl+g"], help: ["ctrl+g", "help"] }),
      ];
      put(p + "HelpLine" + ws, style.helpLine(th, b, w * 2));
      put(p + "FullHelp" + ws, style.fullHelp(th, [b.slice(0, 2), b.slice(2, 3), b.slice(3)], w * 2));
    }
    for (let h = 0; h < 7; h++) {
      for (const c of [[3, 5, 0], [20, 5, 0], [20, 5, 15], [100, 5, 1], [100, 5, 50], [7, 0, 0]] as const) {
        putL(`${p}Scrollbar/${h}/${c[0]}/${c[1]}/${c[2]}`, style.scrollbar(th, h, c[0], c[1], c[2]));
      }
    }
    for (let f = -1; f < 11; f++) put(`${p}BusyGlyph/${f}`, style.busyGlyph(th, f));
    put(p + "BusyLabel", style.busyLabel(th, 2, "checking…"));
    put(p + "Buttons", style.buttons(th, ["Run", "Cancel"], 0));
    put(p + "Buttons/none", style.buttons(th, ["Run", "Cancel"], -1));
    put(p + "None", style.none(th));
    put(p + "Divider", style.divider(th, "│"));
    put(p + "Gradient", style.gradient("load out", th.secondary, th.primary, false));
    put(p + "Gradient/1", style.gradient("x", th.secondary, th.primary, true));
    for (let s = 0; s < 8; s++) put(`${p}StatusGlyph/${s}`, style.renderSpan(th, style.statusGlyph(th, s)));
    const d: style.Dialog = {
      title: "Upgrade",
      info: "2 steps",
      body: ["omarchy   omarchy update -y", "brew      brew upgrade"],
      buttons: ["Run", "Cancel"],
      focused: 0,
      help: "←→ choose • enter press • esc cancel",
    };
    for (const [sw, sh] of [[120, 40], [30, 8], [12, 6], [4, 2], [40, 9]] as const) {
      putL(`${p}Dialog/a/${sw}x${sh}`, style.renderDialog(d, th, sw, sh));
    }
    const long: style.Dialog = { title: "List", body: Array.from({ length: 50 }, () => "x".repeat(200)), destructive: true, focused: -1 };
    putL(p + "Dialog/long", style.renderDialog(long, th, 200, 60));
    long.maxWidth = style.DialogWideMaxWidth;
    putL(p + "Dialog/wide", style.renderDialog(long, th, 200, 60));
    putL(p + "Dialog/small", style.renderDialog(long, th, 30, 8));
    putL(p + "Dialog/fixed", style.renderDialog({ title: "T", width: 30, body: [style.fg(th.error, "err")], buttons: ["OK"], focused: 0 }, th, 80, 24));
  }
  const bg = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd"];
  putL("Overlay/at", style.overlay(bg, ["XX", "YY"], 3, 1));
  putL("Overlay/centre", style.center(bg, ["XX", "YY"], 10, 4));
  putL("Overlay/short", style.overlay(["ab"], ["Z"], 4, 0));
  putL("Overlay/bottom", style.overlay(["ab"], ["Z"], 0, 2));
  putL("Overlay/wideleft", style.overlay(["世界世界"], ["Z"], 1, 0));
  putL("Overlay/wideright", style.overlay(["世界世界"], ["Z"], 0, 0));
  putL("Overlay/styled", style.overlay([style.fg(charmtone.Coral, "rrrrrrrr")], ["Z"], 2, 0));
  putL("Overlay/neg", style.overlay(["abc", "def"], ["Z", "Y"], -2, -1));
  ["loadout · hello", "世界世界", "🎉ok👍🏽x", "étude", "\x1b[31mred\x1b[m plain", "a\tb", ""].forEach((s, si) => {
    for (let w = -1; w < 12; w++) {
      put(`Fit/${si}/${w}`, style.fit(s, w));
      put(`Truncate/${si}/${w}`, style.truncate(s, w));
    }
    put(`Width/${si}`, String(style.width(s)));
  });
  return out;
}

describe("rendering matches the Go reference byte for byte", () => {
  const got = render();
  const want = golden as Record<string, string>;
  test("every case is rendered", () => {
    expect([...got.keys()].sort()).toEqual(Object.keys(want).sort());
  });
  const groups = new Map<string, string[]>();
  for (const k of Object.keys(want)) {
    const g = k.split("/").slice(0, 2).join("/");
    groups.set(g, [...(groups.get(g) ?? []), k]);
  }
  for (const [g, keys] of groups) {
    test(g, () => {
      const diffs = keys.filter((k) => got.get(k) !== want[k]).map((k) => ({ k, got: got.get(k), want: want[k] }));
      expect(diffs).toEqual([]);
    });
  }
});
