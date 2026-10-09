//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package occdev

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"testing"
)

func TestExclusiveWriteRemovesPartialFileAndAllowsRetry(t *testing.T) {
	if directory := os.Getenv("OCC_TEST_EXCLUSIVE_WRITE_DIRECTORY"); directory != "" {
		// A child confines the real kernel file-size limit to this scenario.
		signal.Ignore(syscall.SIGXFSZ)
		var original syscall.Rlimit
		if err := syscall.Getrlimit(syscall.RLIMIT_FSIZE, &original); err != nil {
			t.Fatal(err)
		}
		limited := original
		limited.Cur = 16
		if err := syscall.Setrlimit(syscall.RLIMIT_FSIZE, &limited); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(directory, "output.json")
		err := exclusiveWrite(path, bytes.Repeat([]byte("x"), 1024), 0600)
		if !errors.Is(err, syscall.EFBIG) {
			t.Fatalf("write error = %v, want native EFBIG", err)
		}
		if err := syscall.Setrlimit(syscall.RLIMIT_FSIZE, &original); err != nil {
			t.Fatal(err)
		}
		if data, err := os.ReadFile(path); !os.IsNotExist(err) {
			t.Fatalf("failed write left output: bytes=%d error=%v", len(data), err)
		}
		if err := exclusiveWrite(path, []byte("recovered"), 0600); err != nil {
			t.Fatalf("retry: %v", err)
		}
		data, err := os.ReadFile(path)
		if err != nil || string(data) != "recovered" {
			t.Fatalf("retry output = %q error=%v", data, err)
		}
		return
	}
	child := exec.Command(os.Args[0], "-test.run=^TestExclusiveWriteRemovesPartialFileAndAllowsRetry$", "-test.v")
	child.Env = append(os.Environ(), "OCC_TEST_EXCLUSIVE_WRITE_DIRECTORY="+t.TempDir())
	if output, err := child.CombinedOutput(); err != nil {
		t.Fatalf("native write child: %v\n%s", err, output)
	}
}

func TestExclusiveWriteKeepsExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "existing.json")
	if err := os.WriteFile(path, []byte("existing"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := exclusiveWrite(path, []byte("replacement"), 0600); !errors.Is(err, os.ErrExist) {
		t.Fatalf("existing target: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "existing" {
		t.Fatalf("existing output = %q error=%v", data, err)
	}
}
