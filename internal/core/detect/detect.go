// Package detect says which system loadout runs on.
package detect

import (
	"io/fs"
	"strings"

	"github.com/josemiguelo/loadout/internal/core/coremodel"
	"github.com/josemiguelo/loadout/internal/core/exec"
	"github.com/josemiguelo/loadout/internal/core/platform"
)

// Detection reads the host: its OS, distro and hostname, and what's on PATH.
type Detection struct {
	runner exec.ProcessRunner
	// root is the filesystem at "/" (os.DirFS("/") in the binary).
	root fs.FS
}

// New is a Detection over root, the filesystem at "/".
func New(runner exec.ProcessRunner, root fs.FS) *Detection { return &Detection{runner, root} }

// DetectSystem is this machine; machineOverride ("" = none) replaces the hostname.
func (d *Detection) DetectSystem(machineOverride string) coremodel.SystemInfo {
	uname := platform.Uname()
	os := coremodel.Linux
	if uname.Sysname == "Darwin" {
		os = coremodel.MacOS
	}
	machine := machineOverride
	if machine == "" {
		machine = platform.Hostname()
	}
	var distro *string
	if os == coremodel.Linux {
		distro = d.DetectDistro()
	}
	return coremodel.SystemInfo{Machine: machine, Os: os, Distro: distro, Arch: uname.Machine}
}

// DetectDistro is the distro id from /etc/os-release (e.g. "fedora", "ubuntu", "arch"), or nil.
func (d *Detection) DetectDistro() *string {
	data, err := fs.ReadFile(d.root, "etc/os-release")
	if err != nil {
		return nil
	}
	for _, line := range lines(string(data)) {
		if id, ok := strings.CutPrefix(line, "ID="); ok {
			id = strings.Trim(id, `"'`)
			if strings.TrimSpace(id) == "" {
				return nil
			}
			return &id
		}
	}
	return nil
}

// IsBinaryAvailable says whether binary exists on this machine's PATH.
func (d *Detection) IsBinaryAvailable(binary string) (bool, error) {
	r, err := d.runner.Capture(exec.Line("command -v "+binary, ""))
	return r.Success(), err
}

func lines(s string) []string {
	return strings.Split(strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n"), "\n")
}
