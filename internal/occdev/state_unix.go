//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package occdev

import (
	"fmt"
	"os"
	"syscall"
)

func checkKubernetesPlatform() error { return nil }

func privateOwned(path string, directory bool) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) || info.Mode().Perm()&0077 != 0 || info.IsDir() != directory || (!directory && !info.Mode().IsRegular()) {
		return fmt.Errorf("%s must be private and owned by the current user", path)
	}
	return nil
}

// Keep a start and stop from operating on the same owned state concurrently.
func lockState(directory string) (*os.File, error) {
	file, err := os.Open(directory)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		return nil, fmt.Errorf("development lifecycle is already using %s", directory)
	}
	return file, nil
}
