//go:build !darwin && !dragonfly && !freebsd && !linux && !netbsd && !openbsd

package occdev

import "os/exec"

func ownCommand(cmd *exec.Cmd) {}
