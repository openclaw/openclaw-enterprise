//go:build linux

// This program is the only external command the example's workspace probe admits.
package main

import (
	"fmt"
	"io"
	"os"
	"syscall"
)

const markerName = ".oce-model-marker"
const markerLength = 48

func verify(args []string, output io.Writer) error {
	if len(args) != 0 {
		return fmt.Errorf("unexpected arguments")
	}
	fd, err := syscall.Open(markerName, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(fd), markerName)
	defer file.Close()
	var marker syscall.Stat_t
	if err := syscall.Fstat(fd, &marker); err != nil {
		return err
	}
	if marker.Mode&syscall.S_IFMT != syscall.S_IFREG || marker.Nlink != 1 || marker.Size != markerLength+1 {
		return fmt.Errorf("invalid marker file")
	}
	data, err := io.ReadAll(io.LimitReader(file, markerLength+2))
	if err != nil {
		return err
	}
	if len(data) != markerLength+1 || data[markerLength] != '\n' {
		return fmt.Errorf("invalid marker length")
	}
	for _, c := range data[:markerLength] {
		if !('0' <= c && c <= '9') && !('a' <= c && c <= 'f') {
			return fmt.Errorf("invalid marker")
		}
	}
	_, err = fmt.Fprintf(output, "OCE_BOX_MARKER_IDENTITY %d %d %d\nOCE_BOX_MODEL_MARKER %s",
		os.Geteuid(), marker.Dev, marker.Ino, data)
	return err
}

func main() {
	if err := verify(os.Args[1:], os.Stdout); err != nil {
		// The calling Agent should not see other bytes or paths on refusal.
		fmt.Fprintln(os.Stderr, "OCE_BOX_WORKSPACE_VERIFIER_REFUSED")
		os.Exit(1)
	}
}
