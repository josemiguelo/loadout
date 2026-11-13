import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { deflateRawSync } from "node:zlib";
import { asset, prune, sumOf, unpack } from "./bun.ts";

const tempDir = () => mkdtempSync(tmpdir() + "/loadout-bun-");

test("asset is bun's release zip for the os and arch", () => {
  const cases: [string, string, boolean, string][] = [
    ["linux", "amd64", true, "bun-linux-x64.zip"],
    ["linux", "amd64", false, "bun-linux-x64-baseline.zip"],
    ["linux", "arm64", false, "bun-linux-aarch64.zip"],
    ["darwin", "arm64", false, "bun-darwin-aarch64.zip"],
    ["darwin", "amd64", true, "bun-darwin-x64.zip"],
  ];
  for (const [goos, goarch, avx2, want] of cases) expect(asset(goos, goarch, avx2)).toBe(want);
  expect(() => asset("windows", "amd64", true)).toThrow("bun has no build for windows");
  expect(() => asset("linux", "riscv64", true)).toThrow("bun has no build for linux/riscv64");
});

test("sumOf reads SHASUMS lines", () => {
  const a = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const b = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
  const sums = a + "  bun-linux-x64.zip\n" + b + "  bun-linux-x64-baseline.zip\n";
  expect(sumOf(sums, "bun-linux-x64-baseline.zip")).toBe(b);
  expect(sumOf(sums, "bun-darwin-x64.zip")).toBeUndefined();
});

/** zipOf is a zip of files, as Go's zip.Writer.Create writes them (deflated). */
function zipOf(files: Record<string, string>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = new TextEncoder().encode(name);
    const data = new TextEncoder().encode(content);
    const packed = new Uint8Array(deflateRawSync(data));
    const crc = Bun.hash.crc32(data) >>> 0;
    const local = new Uint8Array(30 + nameBytes.length + packed.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(8, 8, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, packed.length, true);
    l.setUint32(22, data.length, true);
    l.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(packed, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(10, 8, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, packed.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, nameBytes.length, true);
    c.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const dirSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, centrals.length, true);
  e.setUint16(10, centrals.length, true);
  e.setUint32(12, dirSize, true);
  e.setUint32(16, offset, true);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
}

test("unpack writes the binary executable", () => {
  const dir = tempDir() + "/out";
  unpack(zipOf({ "bun-linux-x64/": "", "bun-linux-x64/bun": "#!/bin/sh\n", "bun-linux-x64/LICENSE": "MIT" }), dir);
  expect(statSync(dir + "/bun").mode & 0o111).not.toBe(0);
  expect(() => unpack(zipOf({ "x/README": "" }), tempDir())).toThrow("no bun binary in it");
  expect(() => unpack(new Uint8Array([1, 2, 3]), tempDir())).toThrow("zip: not a valid zip file");
});

test("prune keeps the version in use and fresh work folders", () => {
  const home = tempDir();
  for (const d of ["1.2.0", "1.3.0", ".1.3.0-fresh", ".1.1.0-stale"]) mkdirSync(home + "/" + d);
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  utimesSync(home + "/.1.1.0-stale", old, old);
  prune(home, "1.3.0");
  expect(readdirSync(home).sort()).toEqual([".1.3.0-fresh", "1.3.0"]);
});
