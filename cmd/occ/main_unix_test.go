//go:build darwin || linux

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestRepeatedInterruptStopsBlockedCLI(t *testing.T) {
	if path := os.Getenv("OCC_TEST_SIGNAL_KEY_FILE"); path != "" {
		os.Args = []string{"occ", "--url", "http://127.0.0.1:1", "--service-key-file", path, "namespace", "list"}
		main()
		os.Exit(0)
	}
	for _, second := range []os.Signal{os.Interrupt, syscall.SIGTERM} {
		t.Run(second.String(), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "key-response.fifo")
			if err := syscall.Mkfifo(path, 0o600); err != nil {
				t.Fatal(err)
			}
			child := exec.Command(os.Args[0], "-test.run=^TestRepeatedInterruptStopsBlockedCLI$")
			child.Env = append(os.Environ(), "OCC_TEST_SIGNAL_KEY_FILE="+path)
			if err := child.Start(); err != nil {
				t.Fatal(err)
			}
			done := make(chan struct{})
			var waitErr error
			go func() {
				waitErr = child.Wait()
				close(done)
			}()
			t.Cleanup(func() {
				_ = child.Process.Kill()
				select {
				case <-done:
				case <-time.After(5 * time.Second):
					t.Error("CLI process was not reaped")
				}
			})
			// Opening the writer proves main installed its handler and reached the real
			// key-file read. Keep it open without data to block that non-context I/O.
			var writer *os.File
			deadline := time.Now().Add(10 * time.Second)
			for {
				var err error
				writer, err = os.OpenFile(path, os.O_WRONLY|syscall.O_NONBLOCK, 0)
				if err == nil {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("CLI did not open the key file: %v", err)
				}
				time.Sleep(10 * time.Millisecond)
			}
			defer writer.Close()
			if err := child.Process.Signal(os.Interrupt); err != nil {
				t.Fatal(err)
			}
			select {
			case <-done:
				t.Fatalf("first interrupt must allow graceful cancellation: %v", waitErr)
			case <-time.After(300 * time.Millisecond):
			}
			if err := child.Process.Signal(second); err != nil {
				t.Fatal(err)
			}
			select {
			case <-done:
				var exited *exec.ExitError
				if !errors.As(waitErr, &exited) {
					t.Fatalf("forced interruption did not fail: %v", waitErr)
				}
				status, ok := exited.Sys().(syscall.WaitStatus)
				if !ok || !status.Signaled() || status.Signal() != second {
					t.Fatalf("expected termination by %s, got %v", second, waitErr)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("CLI ignored the second interrupt while the key-file read was blocked")
			}
		})
	}
}
