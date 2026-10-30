package platform

import "golang.org/x/sys/unix"

// The termios ioctls, which Linux and the BSDs name differently.
const (
	ioctlGetTermios = unix.TIOCGETA
	ioctlSetTermios = unix.TIOCSETA
)
