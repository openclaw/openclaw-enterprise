//go:build linux

package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestVerifyOnlyReadsTheSingleMarker(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Chdir(workspace)
	marker := strings.Repeat("a1", markerLength/2) + "\n"
	sibling := filepath.Join(root, "sibling")
	if err := os.WriteFile(sibling, []byte(marker), 0o600); err != nil {
		t.Fatal(err)
	}
	assertRefused := func(args ...string) {
		t.Helper()
		var out bytes.Buffer
		if err := verify(args, &out); err == nil || out.Len() != 0 {
			t.Fatalf("refusal returned success or emitted marker data")
		}
	}
	t.Run("missing", func(t *testing.T) { assertRefused() })
	t.Run("symbolic link", func(t *testing.T) {
		if err := os.Symlink(sibling, markerName); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Remove(markerName) })
		assertRefused()
	})
	t.Run("hard link", func(t *testing.T) {
		if err := os.Link(sibling, markerName); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Remove(markerName) })
		assertRefused()
	})
	t.Run("FIFO", func(t *testing.T) {
		if err := syscall.Mkfifo(markerName, 0o600); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Remove(markerName) })
		assertRefused()
	})
	if err := os.WriteFile(markerName, []byte(strings.Repeat("Z", markerLength)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	assertRefused()
	if err := os.WriteFile(markerName, []byte(marker), 0o600); err != nil {
		t.Fatal(err)
	}
	assertRefused(sibling)
	var identity syscall.Stat_t
	if err := syscall.Stat(markerName, &identity); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := verify(nil, &out); err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("OCE_BOX_MARKER_IDENTITY %d %d %d\nOCE_BOX_MODEL_MARKER %s",
		os.Geteuid(), identity.Dev, identity.Ino, marker)
	if out.String() != want {
		t.Fatal("unexpected verifier output")
	}
	if current, err := os.ReadFile(sibling); err != nil || string(current) != marker {
		t.Fatal("sibling changed")
	}
}
