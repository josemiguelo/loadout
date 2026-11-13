// Package detect says which system loadout runs on.

import { type RepoFS, trimSpace } from "../../model/index.ts";
import { linux, macOS, type SystemInfo } from "../coremodel/coremodel.ts";
import { line, type ProcessRunner, success } from "../exec/exec.ts";
import { hostname, uname } from "../platform/platform.ts";

/** Detection reads the host: its OS, distro and hostname, and what's on PATH. */
export class Detection {
  /** root is the filesystem at "/" (dirFS("/") in the binary). */
  constructor(
    private readonly runner: ProcessRunner,
    private readonly root: RepoFS,
  ) {}

  /** detectSystem is this machine; machineOverride ("" = none) replaces the hostname. */
  detectSystem(machineOverride = ""): SystemInfo {
    const u = uname();
    const os = u.sysname === "Darwin" ? macOS : linux;
    const machine = machineOverride === "" ? hostname() : machineOverride;
    const distro = os === linux ? this.detectDistro() : undefined;
    return { machine, os, distro, arch: u.machine };
  }

  /** detectDistro is the distro id from /etc/os-release (e.g. "fedora", "ubuntu", "arch"), or undefined. */
  detectDistro(): string | undefined {
    let data: string;
    try {
      data = new TextDecoder().decode(this.root.readFile("etc/os-release"));
    } catch {
      return undefined;
    }
    for (const l of lines(data)) {
      if (l.startsWith("ID=")) {
        const id = trim(l.slice(3), `"'`);
        if (trimSpace(id) === "") return undefined;
        return id;
      }
    }
    return undefined;
  }

  /** isBinaryAvailable says whether binary exists on this machine's PATH. */
  async isBinaryAvailable(binary: string): Promise<boolean> {
    return success(await this.runner.capture(line("command -v " + binary, "")));
  }
}

/** newDetection is a Detection over root, the filesystem at "/" (Go's detect.New). */
export function newDetection(runner: ProcessRunner, root: RepoFS): Detection {
  return new Detection(runner, root);
}

function lines(s: string): string[] {
  return s.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
}

/** trim is Go's strings.Trim: cutset's characters off both ends. */
function trim(s: string, cutset: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && cutset.includes(s[start]!)) start++;
  while (end > start && cutset.includes(s[end - 1]!)) end--;
  return s.slice(start, end);
}
