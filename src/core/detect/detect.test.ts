import { expect, test } from "bun:test";
import { mapFS } from "../../model/index.ts";
import { newRunner, stdout } from "../exec/fakeexec/fakeexec.ts";
import { type Detection, newDetection } from "./detect.ts";

const osRelease = (text: string) => mapFS({ "etc/os-release": text });

const distro = (d: Detection) => d.detectDistro() ?? "<nil>";

test("parses distro from os-release", () => {
  const d = newDetection(newRunner(), osRelease('NAME="Fedora Linux"\nVERSION="44 (Workstation Edition)"\nID=fedora\nVERSION_ID=44'));
  expect(distro(d)).toBe("fedora");
});

test("parses quoted distro id", () => {
  expect(distro(newDetection(newRunner(), osRelease('ID="opensuse-leap"\n')))).toBe("opensuse-leap");
});

test("missing os-release gives nil distro", () => {
  expect(distro(newDetection(newRunner(), mapFS({})))).toBe("<nil>");
});

test("binary availability probes via command -v", async () => {
  const d = newDetection(newRunner().onCommand("command -v dnf", stdout("/usr/bin/dnf")), mapFS({}));
  expect(await d.isBinaryAvailable("dnf")).toBe(true);
  expect(await d.isBinaryAvailable("pacman")).toBe(false);
});

test("the machine override names the system", () => {
  expect(newDetection(newRunner(), mapFS({})).detectSystem("work").machine).toBe("work");
});
