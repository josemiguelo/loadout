//go:build !darwin

package term

import "os"

// prepareMaster keeps the master pollable (Linux's epoll reports the
// hang-up as EIO), so Close can interrupt a pending Read even while a
// grandchild still holds the tty.
func prepareMaster(*os.File) {}
