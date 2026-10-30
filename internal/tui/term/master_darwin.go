package term

import "os"

// prepareMaster puts the master in blocking mode: kqueue doesn't report a
// macOS PTY's hang-up, so a pollable Read would never see the child's EOF.
// Close then can't interrupt a Read; the reader ends when the last holder
// of the tty closes it (Close kills the child's groups first).
func prepareMaster(f *os.File) { _ = f.Fd() }
