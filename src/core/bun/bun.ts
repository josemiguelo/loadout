// Package bun keeps the bun a repo pins (`repo({ bun: "…" })`): downloaded
// from bun's GitHub release on first use, checked against the release's
// SHASUMS256.txt, unpacked into $XDG_DATA_HOME/loadout/bun/<version>/. Every
// manifest command gets that folder first on PATH (exec.CommandFrame), so a
// `#!/usr/bin/env bun` script runs on a machine that has nothing installed
// yet, before any program could have installed bun.

import { CryptoHasher } from "bun";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cleanPath, goPathError, joinPath, trimSpace } from "../../model/index.ts";
import { line, type ProcessRunner } from "../exec/exec.ts";
import { envVar } from "../platform/platform.ts";
import { zipEntries } from "./zip.ts";

/**
 * downloadBaseVar overrides where releases come from: a folder (an https or
 * file:// URL, anything curl reads) holding SHASUMS256.txt and the zips, for
 * tests and mirrors. Default: bun's GitHub release of the version.
 */
export const downloadBaseVar = "LOADOUT_BUN_DOWNLOAD_BASE";

const sumsFile = "SHASUMS256.txt";

/**
 * binVar names a bun binary to use instead of any download (a CI runner's,
 * the developer's): compile and every manifest command take it as it is.
 */
export const binVar = "LOADOUT_BUN";

/**
 * defaultVersion is the bun compile runs manifests with in a repo whose lock
 * pins none yet (a first compile): the one this loadout was released with.
 */
export const defaultVersion = "1.4.3";

/**
 * home is where loadout keeps its buns: $XDG_DATA_HOME/loadout/bun, else
 * ~/.local/share/loadout/bun. Throws when HOME isn't set either.
 */
export function home(): string {
  const data = envVar("XDG_DATA_HOME");
  if (data !== undefined && data !== "") return joinPath(data, "loadout", "bun");
  const h = envVar("HOME");
  if (h === undefined || h === "") throw new Error("bun: HOME isn't set, so there's nowhere to keep it");
  return joinPath(h, ".local", "share", "loadout", "bun");
}

/**
 * asset is the release zip for goos/goarch (Go's names: linux/darwin,
 * amd64/arm64): bun-<os>-<arch>.zip, the -baseline build on x64 without
 * AVX2 (bun's default build needs it). Throws for a platform bun doesn't build.
 */
export function asset(goos: string, goarch: string, avx2: boolean): string {
  let system: string;
  switch (goos) {
    case "linux":
      system = "linux";
      break;
    case "darwin":
      system = "darwin";
      break;
    default:
      throw new Error("bun has no build for " + goos);
  }
  let arch: string;
  switch (goarch) {
    case "amd64":
      arch = avx2 ? "x64" : "x64-baseline";
      break;
    case "arm64":
      arch = "aarch64";
      break;
    default:
      throw new Error("bun has no build for " + goos + "/" + goarch);
  }
  return "bun-" + system + "-" + arch + ".zip";
}

/**
 * ensure is the folder holding bun `version`'s binary, downloaded and
 * unpacked the first time; afterwards a stat. Once it's in place, the other
 * versions there go: a repo runs one bun.
 */
export async function ensure(runner: ProcessRunner, version: string): Promise<string> {
  const bin = envVar(binVar);
  if (bin !== undefined && bin !== "") {
    if (!isExecutable(bin)) throw new Error(binVar + "=" + bin + " isn't an executable bun");
    return dir(bin);
  }
  const buns = home();
  const target = joinPath(buns, version);
  if (isExecutable(joinPath(target, "bun"))) return target;
  const zip = asset(goos(), goarch(), hasAVX2());
  let base = envVar(downloadBaseVar);
  if (base === undefined || base === "") base = "https://github.com/oven-sh/bun/releases/download/bun-v" + version;
  if (base.endsWith("/")) base = base.slice(0, -1);
  const fail = (why: string) => new Error("couldn't install bun " + version + ": " + why);
  try {
    mkdirSync(buns, { recursive: true, mode: 0o755 });
  } catch (e) {
    throw fail(goPathError(e, "mkdir").message);
  }
  let work: string;
  try {
    work = mkdtempSync(joinPath(buns, "." + version + "-"));
  } catch (e) {
    throw fail(goPathError(e, "mkdirtemp", joinPath(buns, "." + version + "-*")).message);
  }
  try {
    const sums = await download(runner, base + "/" + sumsFile, joinPath(work, sumsFile)).catch((e: Error) => {
      throw fail(e.message);
    });
    const want = sumOf(new TextDecoder().decode(sums), zip);
    if (want === undefined) throw fail(sumsFile + " lists no " + zip);
    const archive = await download(runner, base + "/" + zip, joinPath(work, zip)).catch((e: Error) => {
      throw fail(e.message);
    });
    if (new CryptoHasher("sha256").update(archive).digest("hex") !== want) {
      throw fail(zip + " doesn't match its checksum in " + sumsFile);
    }
    const unpacked = joinPath(work, "unpacked");
    try {
      unpack(archive, unpacked);
    } catch (e) {
      throw fail(zip + ": " + (e as Error).message);
    }
    // Into place whole: a download cut short never looks installed. Another
    // loadout that got there first is as good.
    try {
      renameSync(unpacked, target);
    } catch (e) {
      if (!isExecutable(joinPath(target, "bun"))) throw fail(goPathError(e, "rename").message);
    }
    prune(buns, version);
    return target;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** download is url's content, fetched by curl into file; throws with what curl said. */
async function download(runner: ProcessRunner, url: string, file: string): Promise<Uint8Array> {
  const result = await runner.capture(line("curl -fsSL --retry 2 -o " + quote(file) + " " + quote(url), ""));
  if (result.exitCode !== 0) {
    let why = trimSpace(result.stderr);
    if (why === "") why = "curl exited " + result.exitCode;
    throw new Error(url + ": " + why);
  }
  try {
    return new Uint8Array(readFileSync(file));
  } catch (e) {
    throw goPathError(e, undefined, file);
  }
}

/** sumLine is a SHASUMS256.txt line; the classes are RE2's \s and \S (ASCII space only). */
const sumLine = /^([0-9a-f]{64})[\t\n\f\r ]+\*?([^\t\n\f\r ]+)$/;

/** sumOf is asset's sha256 in a SHASUMS256.txt ("<hex>  <file>" per line), undefined when it isn't listed. */
export function sumOf(sums: string, asset: string): string | undefined {
  for (const l of sums.split("\n")) {
    const m = sumLine.exec(trimSpace(l));
    if (m !== null && m[2] === asset) return m[1];
  }
  return undefined;
}

/**
 * unpack writes the zip's `bun` binary (bun-<os>-<arch>/bun in a release)
 * into dir as dir/bun, executable. Throws when it can't.
 */
export function unpack(archive: Uint8Array, dir: string): void {
  for (const f of zipEntries(archive)) {
    if (f.isDir || f.name.slice(f.name.lastIndexOf("/") + 1) !== "bun") continue;
    const data = f.read();
    try {
      mkdirSync(dir, { recursive: true, mode: 0o755 });
    } catch (e) {
      throw goPathError(e, "mkdir");
    }
    const out = joinPath(dir, "bun");
    try {
      writeFileSync(out, data, { mode: 0o755 });
    } catch (e) {
      throw goPathError(e, "open", out);
    }
    return;
  }
  throw new Error("no bun binary in it");
}

/**
 * prune removes every bun in home but keep's, and work folders a loadout
 * left behind more than a day ago (a fresh one may be another loadout's,
 * still downloading).
 */
export function prune(home: string, keep: string): void {
  let entries;
  try {
    entries = readdirSync(home, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const name = e.name;
    if (name === keep || !e.isDirectory()) continue;
    if (name.startsWith(".")) {
      try {
        if (Date.now() - lstatSync(joinPath(home, name)).mtimeMs < 24 * 60 * 60 * 1000) continue;
      } catch {
        continue;
      }
    }
    try {
      rmSync(joinPath(home, name), { recursive: true, force: true });
    } catch {
      // best effort, as Go's ignored RemoveAll
    }
  }
}

function isExecutable(file: string): boolean {
  try {
    const st = statSync(file);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** dir is Go's filepath.Dir: everything before the last slash, cleaned ("." when there is none). */
function dir(path: string): string {
  const i = path.lastIndexOf("/");
  return cleanPath(path.slice(0, i + 1) || ".");
}

/** quote is s as one sh word. */
function quote(s: string): string {
  return "'" + s.replaceAll("'", `'\\''`) + "'";
}

/** goos is this platform as Go names it (runtime.GOOS). */
function goos(): string {
  return process.platform;
}

/** goarch is this CPU as Go names it (runtime.GOARCH). */
function goarch(): string {
  return process.arch === "x64" ? "amd64" : process.arch;
}

/**
 * hasAVX2 says whether this x64 CPU has AVX2 (Go's cpu.X86.HasAVX2): the
 * kernel's cpuinfo flags on Linux, sysctl hw.optional.avx2_0 on macOS.
 * False when it can't tell: the baseline build runs everywhere.
 */
function hasAVX2(): boolean {
  if (process.arch !== "x64") return false;
  if (process.platform === "linux") {
    try {
      const flags = readFileSync("/proc/cpuinfo", "utf8")
        .split("\n")
        .find((l) => l.startsWith("flags"));
      return flags !== undefined && flags.split(/[\s:]+/).includes("avx2");
    } catch {
      return false;
    }
  }
  if (process.platform === "darwin") {
    try {
      const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
        sysctlbyname: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
      });
      const value = new Int32Array(1);
      const size = new BigUint64Array([4n]);
      const name = Buffer.from("hw.optional.avx2_0\0");
      return symbols.sysctlbyname(ptr(name), ptr(value), ptr(size), null, 0) === 0 && value[0] === 1;
    } catch {
      return false;
    }
  }
  return false;
}
