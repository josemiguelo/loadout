package detect

import (
	"testing"
	"testing/fstest"

	"github.com/josemiguelo/loadout/internal/core/exec/fakeexec"
)

func osRelease(text string) fstest.MapFS {
	return fstest.MapFS{"etc/os-release": &fstest.MapFile{Data: []byte(text)}}
}

func distro(d *Detection) string {
	if id := d.DetectDistro(); id != nil {
		return *id
	}
	return "<nil>"
}

func TestParsesDistroFromOsRelease(t *testing.T) {
	d := New(fakeexec.New(), osRelease("NAME=\"Fedora Linux\"\nVERSION=\"44 (Workstation Edition)\"\nID=fedora\nVERSION_ID=44"))
	if got := distro(d); got != "fedora" {
		t.Error(got)
	}
}

func TestParsesQuotedDistroId(t *testing.T) {
	if got := distro(New(fakeexec.New(), osRelease("ID=\"opensuse-leap\"\n"))); got != "opensuse-leap" {
		t.Error(got)
	}
}

func TestMissingOsReleaseGivesNilDistro(t *testing.T) {
	if got := distro(New(fakeexec.New(), fstest.MapFS{})); got != "<nil>" {
		t.Error(got)
	}
}

func TestBinaryAvailabilityProbesViaCommandV(t *testing.T) {
	d := New(fakeexec.New().OnCommand("command -v dnf", fakeexec.Stdout("/usr/bin/dnf")), fstest.MapFS{})
	if ok, _ := d.IsBinaryAvailable("dnf"); !ok {
		t.Error("dnf")
	}
	if ok, _ := d.IsBinaryAvailable("pacman"); ok {
		t.Error("pacman")
	}
}

func TestTheMachineOverrideNamesTheSystem(t *testing.T) {
	if got := New(fakeexec.New(), fstest.MapFS{}).DetectSystem("work").Machine; got != "work" {
		t.Error(got)
	}
}
