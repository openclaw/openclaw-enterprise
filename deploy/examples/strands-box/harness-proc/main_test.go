//go:build linux && (amd64 || arm64)

package main

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

func openOriginal(t *testing.T) *os.File {
	t.Helper()
	fd, err := syscall.Open("/proc", syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		t.Fatal(err)
	}
	f := os.NewFile(uintptr(fd), "/proc")
	t.Cleanup(func() { f.Close() })
	return f
}

func TestReadsActualKernelInputsFromPinnedDescriptor(t *testing.T) {
	proc := openOriginal(t)
	result, err := readSnapshot(int(proc.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	if result.Proc.Ino != "1" || result.Proc.MountID == "" ||
		!regexp.MustCompile(`^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$`).MatchString(result.BootID) ||
		!strings.Contains(result.MountInfo, " /proc ") {
		t.Fatal("incomplete kernel snapshot")
	}
}

func TestRefusesCopiedProcTreeAndWrongKernelDirectory(t *testing.T) {
	copyRoot := t.TempDir()
	target := filepath.Join(copyRoot, "self", "mountinfo")
	contents, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, contents, 0600); err != nil {
		t.Fatal(err)
	}
	copyDir, err := os.Open(copyRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer copyDir.Close()
	if _, err := readSnapshot(int(copyDir.Fd())); err == nil || err.Error() != "procfs required" {
		t.Fatalf("copied procfs input was accepted or refused for the wrong reason: %v", err)
	}
	wrong, err := os.Open("/proc/self")
	if err != nil {
		t.Fatal(err)
	}
	defer wrong.Close()
	if _, err := readSnapshot(int(wrong.Fd())); err == nil || err.Error() != "procfs root required" {
		t.Fatalf("another kernel directory was accepted or refused for the wrong reason: %v", err)
	}
}

func TestKernelRefusesMagicLinkAndActualMountCrossing(t *testing.T) {
	proc := openOriginal(t)
	fd := int(proc.Fd())
	if _, err := openKernelAt(fd, "self/root/proc/self/mountinfo", true); !errors.Is(err, syscall.ELOOP) {
		t.Fatalf("kernel magic link refusal: %v", err)
	}
	// Starting from / rather than the pinned procfs requires a genuine mount
	// crossing to reach this kernel file, even though it is the right file type.
	root, err := os.Open("/")
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	path := "proc/" + strconv.Itoa(os.Getpid()) + "/mountinfo"
	if _, err := openKernelAt(int(root.Fd()), path, false); !errors.Is(err, syscall.EXDEV) {
		t.Fatalf("kernel mount crossing refusal: %v", err)
	}
}
